'use strict';

import { access, popen, readfile, stat } from 'fs';
import { cursor } from 'uci';

const CFG     = 'tunnel-server-hysteria2';
const CONF    = '/etc/tunnel-server-hysteria2/config.json';
const ERROR   = '/tmp/tunnel-server-hysteria2/error';
const SINGBOX = '/usr/bin/sing-box';
const INIT    = '/etc/init.d/tunnel-server-hysteria2';
const RULE    = 'tunnel_server_hysteria2';
const DDNS_CERTS = '/etc/ssl/tunnel-ddns';

function exec(command) {
	let p = popen(command, 'r');
	if (p == null)
		return { code: -1, out: '' };
	let out = p.read('all') ?? '';
	return { code: p.close(), out: out };
}

function shq(s) {
	return "'" + replace(`${s ?? ''}`, "'", "'\\''") + "'";
}

function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, length(lines) - n);
	return join('\n', lines);
}

function valid_sid(s) {
	return type(s) == 'string' && match(s, /^[A-Za-z0-9_]{1,64}$/) != null;
}

function urlenc(s) {
	let out = '';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		out += match(c, /^[A-Za-z0-9._~-]$/) ? c : sprintf('%%%02X', ord(s, i));
	}
	return out;
}

function singbox_version() {
	if (access(SINGBOX, 'x') != true)
		return '';
	let m = match(exec(`${SINGBOX} version 2>/dev/null`).out, /sing-box version ([0-9][^ \n]*)/);
	return m ? m[1] : '';
}

function service() {
	let r = exec(`ubus call service list ${shq('{"name":"' + CFG + '"}')} 2>/dev/null`);
	let j;
	try { j = json(r.out); } catch (e) { return { running: false }; }
	let inst = j?.[CFG]?.instances?.hysteria2;
	return { running: (inst?.running == true), pid: inst?.pid };
}

function singbox_log() {
	return exec(`logread 2>/dev/null | grep -E 'tunnel-server-hysteria2|sing-box\\['`).out;
}

function cert_info(path) {
	if (!path || access(path) != true)
		return null;
	let r = exec(`openssl x509 -noout -subject -enddate -in ${shq(path)} 2>/dev/null`);
	if (r.code != 0)
		return { error: 'cannot read the certificate' };
	let cn = match(r.out, /CN[ \t]*=[ \t]*([^,\n]+)/);
	let na = match(r.out, /notAfter=(.+)/);
	let valid = exec(`openssl x509 -checkend 0 -noout -in ${shq(path)} 2>/dev/null`).code == 0;
	return { cn: cn ? trim(cn[1]) : '', not_after: na ? trim(na[1]) : '', valid: valid, path: path };
}

// the domains of the Dynamic DNS package and whether each has a certificate
function ddns_domains(uci) {
	let out = [];
	if (!uci.load('tunnel-ddns'))
		return out;
	uci.foreach('tunnel-ddns', 'domain', function(s) {
		let host = s.hostname ?? '';
		if (!host) return;
		let c = cert_info(`${DDNS_CERTS}/${host}/fullchain.pem`);
		push(out, { id: s['.name'], hostname: host, has_cert: (c != null && !c.error), not_after: c?.not_after ?? '', valid: c?.valid ?? false });
	});
	return out;
}

// the certificate the configuration uses (same rules as in sync)
function certificate(main, uci) {
	if ((main.cert_source ?? 'ddns') == 'files') {
		if (!main.cert_path || !main.key_path) return { error: 'the certificate and key paths are empty' };
		if (!main.server_name) return { error: 'the TLS server name is empty' };
		if (access(main.cert_path) != true || access(main.key_path) != true)
			return { error: 'the certificate or key file is missing' };
		return { cert: main.cert_path, key: main.key_path, server_name: main.server_name, source: 'files' };
	}
	if (!main.cert_domain) return { error: 'no domain is selected' };
	if (!uci.load('tunnel-ddns')) return { error: 'the Dynamic DNS package (luci-app-tunnel-ddns) is not installed' };
	let host = uci.get('tunnel-ddns', main.cert_domain, 'hostname');
	if (!host) return { error: 'the selected domain no longer exists on the Dynamic DNS page' };
	let cert = `${DDNS_CERTS}/${host}/fullchain.pem`, key = `${DDNS_CERTS}/${host}/key.pem`;
	if (access(cert) != true || access(key) != true)
		return { error: `no certificate for ${host} yet: issue it on the Dynamic DNS page` };
	return { cert: cert, key: key, server_name: host, source: 'ddns' };
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		uci.load('firewall');
		let main = uci.get_all(CFG, 'main') ?? {};
		let svc = service();
		let st = stat(CONF);
		let enabled = (main.enabled == '1');
		let c = certificate(main, uci);
		let cert = c.error ? { error: c.error } : (cert_info(c.cert) ?? { error: 'cannot read the certificate' });
		if (!cert.error) { cert.server_name = c.server_name; cert.source = c.source; }
		return {
			installed: (access(SINGBOX, 'x') == true),
			version: singbox_version(),
			enabled: enabled,
			running: svc.running,
			pid: svc.pid,
			config_time: st ? st.mtime : null,
			error: trim(readfile(ERROR) ?? ''),
			firewall: (uci.get('firewall', RULE) == 'rule') ? (uci.get('firewall', RULE, 'dest_port') ?? '') : '',
			cert: cert,
			domains: ddns_domains(uci),
			log_last: (enabled && !svc.running) ? tail(singbox_log(), 3) : ''
		};
	}
};

methods.links = {
	args: { profile: '' },
	call: function(req) {
		let sid = req.args.profile;
		if (!valid_sid(sid)) return { error: 'Invalid profile.' };
		let uci = cursor();
		uci.load(CFG);
		if (uci.get(CFG, sid) != 'profile')
			return { error: 'Unknown profile. Click Save & Apply first.' };
		let u = uci.get_all(CFG, sid);
		let main = uci.get_all(CFG, 'main') ?? {};
		if (!u.password) return { error: 'The profile has no password.' };
		if (u.enabled == '0') return { error: 'This profile is switched off; its link would not work.' };
		let c = certificate(main, uci);
		if (c.error) return { error: 'The certificate is not set up: ' + c.error + '.' };
		let host = main.link_host || c.server_name;
		let port = main.link_port || main.port || '8443';
		let name = u.name || sid;
		let link = `hysteria2://${urlenc(u.password)}@${host}:${port}?sni=${urlenc(c.server_name)}`;
		if (main.obfs_password)
			link += `&obfs=salamander&obfs-password=${urlenc(main.obfs_password)}`;
		link += `#${urlenc(name)}`;
		return { name: name, host: host, link: link,
			note: 'Works in clients based on sing-box (Hiddify with its default core, NekoBox, sing-box itself) and in the Hysteria2 apps.' };
	}
};

methods.log = {
	call: function() {
		return { log: tail(singbox_log(), 200) };
	}
};

methods.config = {
	call: function() {
		return { config: readfile(CONF) ?? '', path: CONF };
	}
};

methods.restart = {
	call: function() {
		let r = exec(`${INIT} restart 2>&1`);
		return { ok: (r.code == 0), log: r.out };
	}
};

return { 'tunnel-server-hysteria2': methods };
