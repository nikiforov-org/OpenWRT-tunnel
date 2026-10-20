'use strict';

import { access, popen, readfile, stat } from 'fs';
import { cursor } from 'uci';

const CFG   = 'tunnel-server';
const CONF  = '/etc/tunnel-server/config.json';
const ERROR = '/tmp/tunnel-server/error';
const XRAY  = '/usr/bin/xray';
const INIT  = '/etc/init.d/tunnel-server';
const DDNS_CERTS = '/etc/ssl/tunnel-ddns';
const RULES = { vision: 'tunnel_server_vision', xhttp: 'tunnel_server_xhttp', hysteria2: 'tunnel_server_hysteria2' };

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

function list(v) {
	if (type(v) == 'array') return v;
	return (v == null || v == '') ? [] : [ v ];
}

function valid_sid(s) {
	return type(s) == 'string' && match(s, /^[A-Za-z0-9_]{1,64}$/) != null;
}

function valid_key(k) {
	return type(k) == 'string' && match(k, /^[A-Za-z0-9_-]{43}$/) != null;
}

function urlenc(s) {
	let out = '';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		out += match(c, /^[A-Za-z0-9._~-]$/) ? c : sprintf('%%%02X', ord(s, i));
	}
	return out;
}

// "xray x25519" prints "PrivateKey: …" and the public key as "Public key: …" (old),
// "Password: …" (25.x) or "Password (PublicKey): …" (26.x)
function parse_keys(out) {
	let priv = match(out, /Private ?[Kk]ey *: *([^ \t\n]+)/);
	let pub = match(out, /(Public ?[Kk]ey|Password)( *\([^)]*\))? *: *([^ \t\n]+)/);
	return { private_key: priv ? priv[1] : '', public_key: pub ? pub[3] : '' };
}

function public_key(priv) {
	if (!valid_key(priv) || access(XRAY, 'x') != true)
		return '';
	return parse_keys(exec(`${XRAY} x25519 -i ${shq(priv)} 2>/dev/null`).out).public_key;
}

function xray_version() {
	if (access(XRAY, 'x') != true)
		return '';
	let m = match(exec(`${XRAY} version 2>/dev/null`).out, /Xray ([0-9][^ \n]*)/);
	return m ? m[1] : '';
}

function service() {
	let r = exec(`ubus call service list ${shq('{"name":"' + CFG + '"}')} 2>/dev/null`);
	let j;
	try { j = json(r.out); } catch (e) { return { running: false }; }
	let inst = j?.[CFG]?.instances?.xray;
	return { running: (inst?.running == true), pid: inst?.pid };
}

function xray_log() {
	return exec(`logread 2>/dev/null | grep -E 'tunnel-server|xray\\['`).out;
}

// the web site of the tunnel-ddns package, if that package is installed: the usual target
function ddns_site(uci) {
	if (!uci.load('tunnel-ddns'))
		return null;
	let m = uci.get_all('tunnel-ddns', 'main');
	if (!m) return null;
	let host = m.site_domain ? uci.get('tunnel-ddns', m.site_domain, 'hostname') : null;
	return { enabled: (m.site_enabled == '1'), port: m.site_port ?? '443', hostname: host ?? '' };
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

// the certificate of the Hysteria2 transport (same rules as in sync)
function certificate(main, uci) {
	if ((main.cert_source ?? 'ddns') == 'files') {
		if (!main.cert_path || !main.key_path) return { error: 'the certificate and key paths are empty' };
		if (!main.cert_name) return { error: 'the TLS server name of the certificate is empty' };
		if (access(main.cert_path) != true || access(main.key_path) != true)
			return { error: 'the certificate or key file is missing' };
		return { cert: main.cert_path, key: main.key_path, server_name: main.cert_name, source: 'files' };
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
		let fw = {};
		for (let key, sec in RULES)
			fw[key] = (uci.get('firewall', sec) == 'rule') ? (uci.get('firewall', sec, 'dest_port') ?? '') : '';
		let enabled = (main.enabled == '1');
		let cert = null;
		if (main.hysteria2_enabled == '1') {
			let c = certificate(main, uci);
			cert = c.error ? { error: c.error } : (cert_info(c.cert) ?? { error: 'cannot read the certificate' });
			if (!cert.error) { cert.server_name = c.server_name; cert.source = c.source; }
		}
		return {
			installed: (access(XRAY, 'x') == true),
			version: xray_version(),
			enabled: enabled,
			running: svc.running,
			pid: svc.pid,
			public_key: public_key(main.private_key),
			config_time: st ? st.mtime : null,
			error: trim(readfile(ERROR) ?? ''),
			firewall: fw,
			cert: cert,
			domains: ddns_domains(uci),
			log_last: (enabled && !svc.running) ? tail(xray_log(), 3) : '',
			site: ddns_site(uci)
		};
	}
};

methods.keypair = {
	call: function() {
		if (access(XRAY, 'x') != true)
			return { error: 'xray-core is not installed.' };
		let k = parse_keys(exec(`${XRAY} x25519 2>/dev/null`).out);
		if (!k.private_key || !k.public_key)
			return { error: 'Could not generate a keypair (xray x25519 gave no keys).' };
		return k;
	}
};

methods.pubkey = {
	args: { private_key: '' },
	call: function(req) {
		if (!valid_key(req.args.private_key))
			return { error: 'The private key must be 43 characters of base64url (letters, digits, "-" and "_").' };
		let pub = public_key(req.args.private_key);
		if (!pub)
			return { error: 'xray could not derive a public key from this private key.' };
		return { public_key: pub };
	}
};

// the links of a profile: one per enabled transport; a transport that cannot give a working
// link is listed with the reason instead
methods.links = {
	args: { profile: '' },
	call: function(req) {
		let sid = req.args.profile;
		if (!valid_sid(sid)) return { error: 'Invalid profile.' };
		let uci = cursor();
		uci.load(CFG);
		if (uci.get(CFG, sid) != 'profile')
			return { error: 'Unknown profile. Click Save & Apply first.' };
		let p = uci.get_all(CFG, sid);
		let main = uci.get_all(CFG, 'main') ?? {};
		if (p.enabled == '0') return { error: 'This profile is switched off; its links would not work.' };
		let vision = (main.vision_enabled == '1' && main.vision_port), xhttp = (main.xhttp_enabled == '1' && main.xhttp_port);
		let hy2 = (main.hysteria2_enabled == '1' && main.hysteria2_port);
		if (!vision && !xhttp && !hy2) return { error: 'No transport is enabled.' };
		let site = ddns_site(uci);
		let cert = hy2 ? certificate(main, uci) : null;
		let host = main.link_host || site?.hostname || ((cert && !cert.error) ? cert.server_name : '');
		if (!host) return { error: 'Set the address for client links first (section "Client links").' };
		let name = p.name || sid;
		let links = [];
		if (vision || xhttp) {
			let pub = public_key(main.private_key), sni = list(main.server_name)[0], sid0 = list(main.short_id)[0];
			let why = !p.uuid ? 'the profile has no UUID'
				: !pub ? 'the private key is missing or invalid: generate a keypair and click Save & Apply'
				: !sni ? 'no server name is set' : !sid0 ? 'no short ID is set' : '';
			let common = `encryption=none&security=reality&sni=${urlenc(sni ?? '')}&fp=chrome&pbk=${urlenc(pub)}&sid=${urlenc(sid0 ?? '')}`;
			if (vision)
				push(links, why ? { transport: 'vision', title: 'TCP + Vision', error: why } : {
					transport: 'vision', title: 'TCP + Vision',
					note: 'Works in clients with the Xray core and with sing-box (v2rayNG, Hiddify, Streisand, NekoBox and others).',
					link: `vless://${p.uuid}@${host}:${main.vision_link_port || main.vision_port}?${common}&flow=xtls-rprx-vision&type=tcp&headerType=none#${urlenc(name)}`
				});
			if (xhttp)
				push(links, why ? { transport: 'xhttp', title: 'XHTTP', error: why } : {
					transport: 'xhttp', title: 'XHTTP',
					note: 'Needs a client with the Xray core (v2rayNG, Streisand, Hiddify with the Xray core selected); sing-box has no XHTTP.',
					link: `vless://${p.uuid}@${host}:${main.xhttp_link_port || main.xhttp_port}?${common}&type=xhttp&path=${urlenc(main.xhttp_path || '/')}&mode=${urlenc(main.xhttp_mode || 'auto')}&core=xray#${urlenc(name + '-xhttp')}`
				});
		}
		if (hy2) {
			let why = !p.password ? 'the profile has no Hysteria2 password'
				: cert.error ? 'the certificate is not set up: ' + cert.error : '';
			let link = '';
			if (!why) {
				link = `hysteria2://${urlenc(p.password)}@${host}:${main.hysteria2_link_port || main.hysteria2_port}?sni=${urlenc(cert.server_name)}`;
				if (main.hysteria2_obfs)
					link += `&obfs=salamander&obfs-password=${urlenc(main.hysteria2_obfs)}`;
				link += `#${urlenc(name + '-hysteria2')}`;
			}
			push(links, why ? { transport: 'hysteria2', title: 'Hysteria2', error: why } : {
				transport: 'hysteria2', title: 'Hysteria2',
				note: 'Works in clients with the Xray core, with sing-box (Hiddify, NekoBox) and in the Hysteria2 apps.',
				link: link
			});
		}
		return { name: name, host: host, links: links };
	}
};

methods.log = {
	call: function() {
		return { log: tail(xray_log(), 200) };
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

return { 'tunnel-server': methods };
