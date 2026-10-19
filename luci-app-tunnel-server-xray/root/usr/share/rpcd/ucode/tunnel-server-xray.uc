'use strict';

import { access, popen, readfile, stat } from 'fs';
import { cursor } from 'uci';

const CFG   = 'tunnel-server-xray';
const CONF  = '/etc/tunnel-server-xray/config.json';
const ERROR = '/tmp/tunnel-server-xray/error';
const XRAY  = '/usr/bin/xray';
const INIT  = '/etc/init.d/tunnel-server-xray';
const RULES = { vision: 'tunnel_server_xray_vision', xhttp: 'tunnel_server_xray_xhttp' };

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
	return exec(`logread 2>/dev/null | grep -E 'tunnel-server-xray|xray\\['`).out;
}

function urlenc(s) {
	let out = '';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		out += match(c, /^[A-Za-z0-9._~-]$/) ? c : sprintf('%%%02X', ord(s, i));
	}
	return out;
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

methods.links = {
	args: { client: '' },
	call: function(req) {
		let sid = req.args.client;
		if (!valid_sid(sid)) return { error: 'Invalid client.' };
		let uci = cursor();
		uci.load(CFG);
		if (uci.get(CFG, sid) != 'client')
			return { error: 'Unknown client. Click Save & Apply first.' };
		let c = uci.get_all(CFG, sid);
		let main = uci.get_all(CFG, 'main') ?? {};
		if (!c.uuid) return { error: 'The client has no UUID.' };
		if (c.enabled == '0') return { error: 'This client is switched off; its links would not work.' };
		let pub = public_key(main.private_key);
		if (!pub) return { error: 'The private key is missing or invalid. Generate a keypair and click Save & Apply.' };
		let sni = list(main.server_name)[0];
		let sid0 = list(main.short_id)[0];
		if (!sni) return { error: 'No server name is set.' };
		if (!sid0) return { error: 'No short ID is set.' };
		let site = ddns_site(uci);
		let host = main.link_host || site?.hostname || '';
		if (!host) return { error: 'Set the address for client links first (section "Client links").' };
		let name = c.name || sid;
		let common = `encryption=none&security=reality&sni=${urlenc(sni)}&fp=chrome&pbk=${urlenc(pub)}&sid=${urlenc(sid0)}`;
		let links = [];
		if (main.vision_enabled == '1' && main.vision_port)
			push(links, {
				transport: 'vision',
				title: 'TCP + Vision',
				note: 'Works in clients based on Xray and on sing-box (v2rayNG, Hiddify, Streisand, NekoBox and others).',
				link: `vless://${c.uuid}@${host}:${main.vision_link_port || main.vision_port}?${common}&flow=xtls-rprx-vision&type=tcp&headerType=none#${urlenc(name)}`
			});
		if (main.xhttp_enabled == '1' && main.xhttp_port)
			push(links, {
				transport: 'xhttp',
				title: 'XHTTP',
				note: 'Needs a client with the Xray core (v2rayNG, Streisand, Hiddify with the Xray core selected); sing-box has no XHTTP.',
				link: `vless://${c.uuid}@${host}:${main.xhttp_link_port || main.xhttp_port}?${common}&type=xhttp&path=${urlenc(main.xhttp_path || '/')}&mode=${urlenc(main.xhttp_mode || 'auto')}&core=xray#${urlenc(name + '-xhttp')}`
			});
		if (!length(links)) return { error: 'No transport is enabled.' };
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

return { 'tunnel-server-xray': methods };
