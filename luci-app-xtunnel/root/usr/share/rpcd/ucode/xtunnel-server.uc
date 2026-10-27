'use strict';

import { access, readfile, stat } from 'fs';
import { cursor } from 'uci';
import { XRAY, list, valid_sid, xray_instance, xray_version, x25519, syslog_tail, restart, read_json } from 'xtunnel.common';
import { file_status } from 'xtunnel.x509';
import { urlencode } from 'xtunnel-ddns.http';
import { in_effect } from 'xtunnel-ddns.sitecert';
import { certificate } from 'xtunnel-server.common';

const CFG   = 'xtunnel-server';
const CONF  = '/etc/xtunnel-server/config.json';
const ERROR = '/tmp/xtunnel-server/error';
const INIT  = '/etc/init.d/xtunnel-server';
const DDNS_CERTS = '/etc/ssl/xtunnel-ddns';
const RULES = { vision: 'xtunnel_server_vision', xhttp: 'xtunnel_server_xhttp', hysteria2: 'xtunnel_server_hysteria2' };
const LOG   = 'xtunnel-server|xray\\[';             // its lines in the system log

function valid_key(k) {
	return type(k) == 'string' && match(k, /^[A-Za-z0-9_-]{43}$/) != null;
}

// the public key of a REALITY private key: the one the sync derived for the key in effect
// (/etc/xtunnel-server/pubkey.json), else worked out once here (rpcd keeps this plugin loaded)
let pubkeys = {};
function public_key(priv) {
	if (!valid_key(priv)) return '';
	if (!pubkeys[priv]) {
		let k = read_json('/etc/xtunnel-server/pubkey.json') ?? {};
		if (k.private_key == priv && valid_key(k.public_key)) pubkeys[priv] = k.public_key;
	}
	pubkeys[priv] ??= x25519(priv)?.public_key ?? '';
	return pubkeys[priv];
}

// the web site of the Dynamic DNS page: the usual target
function ddns_site(uci) {
	let m = uci.load('xtunnel-ddns') ? uci.get_all('xtunnel-ddns', 'main') : null;
	if (!m) return null;
	let host = m.site_domain ? uci.get('xtunnel-ddns', m.site_domain, 'hostname') : null;
	// the name whose certificate the router's web server presents (the site moves to a new name later)
	return { enabled: (m.site_enabled == '1'), port: m.site_port ?? '443', hostname: host ?? '', cert_host: in_effect() };
}

// the domains of the Dynamic DNS page and whether each has a certificate
function ddns_domains(uci) {
	let out = [];
	if (!uci.load('xtunnel-ddns'))
		return out;
	uci.foreach('xtunnel-ddns', 'domain', function(s) {
		let host = s.hostname ?? '';
		if (!host) return;
		let c = file_status(`${DDNS_CERTS}/${host}/fullchain.pem`);
		push(out, { id: s['.name'], hostname: host, has_cert: (c != null && !c.error), expires: c?.expires ?? null, valid: c?.valid ?? false });
	});
	return out;
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		uci.load('firewall');
		let main = uci.get_all(CFG, 'main') ?? {};
		let inst = xray_instance(CONF);
		let st = stat(CONF);
		let fw = {};
		for (let key, sec in RULES)
			fw[key] = (uci.get('firewall', sec) == 'rule') ? (uci.get('firewall', sec, 'dest_port') ?? '') : '';
		let enabled = (main.enabled == '1');
		let cert = null;
		if (main.hysteria2_enabled == '1') {
			let c = certificate(main, uci);
			cert = c.error ? { error: c.error } : (file_status(c.cert) ?? { error: 'cannot read the certificate' });
			if (!cert.error) { cert.server_name = c.server_name; cert.source = c.source; }
		}
		return {
			installed: (access(XRAY, 'x') == true),
			version: xray_version(),
			enabled: enabled,
			running: (inst != null),
			pid: inst?.pid,
			public_key: public_key(main.private_key),
			config_time: st ? st.mtime : null,
			error: trim(readfile(ERROR) ?? '') || trim(readfile('/tmp/xtunnel-xray/error') ?? ''),
			firewall: fw,
			cert: cert,
			domains: ddns_domains(uci),
			log_last: (enabled && !inst) ? syslog_tail(LOG, 3) : '',
			site: ddns_site(uci),
			target: main.target ?? '',
			server_names: list(main.server_name)
		};
	}
};

methods.keypair = {
	call: function() {
		if (access(XRAY, 'x') != true)
			return { error: 'xray is not installed (the package xtunnel-core).' };
		return x25519() ?? { error: 'Could not generate a keypair (xray x25519 gave no keys).' };
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

// the links of a profile: one per enabled transport; a transport that cannot give a working link is
// listed with the reason instead
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
		if (!host)
			return { error: 'Set the address in the links first (section "Clients").' };
		let nohost = '';
		let name = p.name || sid;
		let links = [];
		let why = '', common = '';
		if (vision || xhttp) {
			let pub = public_key(main.private_key), sni = list(main.server_name)[0], sid0 = list(main.short_id)[0];
			why = !p.uuid ? 'the profile has no UUID'
				: !pub ? 'the private key is missing or invalid: generate a keypair and click Save & Apply'
				: !sni ? 'no server name is set' : !sid0 ? 'no short ID is set' : '';
			common = `encryption=none&security=reality&sni=${urlencode(sni ?? '')}&fp=chrome&pbk=${urlencode(pub)}&sid=${urlencode(sid0 ?? '')}`;
			if (vision)
				push(links, (why || nohost) ? { transport: 'vision', title: 'TCP + Vision', error: why || nohost } : {
					transport: 'vision', title: 'TCP + Vision',
					note: 'Works in clients with the Xray core and with sing-box (v2rayNG, Hiddify, Streisand, NekoBox and others).',
					link: `vless://${p.uuid}@${host}:${main.vision_link_port || main.vision_port}?${common}&flow=xtls-rprx-vision&type=tcp&headerType=none#${urlencode(name)}`
				});
			if (xhttp)
				push(links, (why || nohost) ? { transport: 'xhttp', title: 'XHTTP', error: why || nohost } : {
					transport: 'xhttp', title: 'XHTTP',
					note: 'Needs a client with the Xray core (v2rayNG, Streisand, Hiddify with the Xray core selected); sing-box has no XHTTP.',
					link: `vless://${p.uuid}@${host}:${main.xhttp_link_port || main.xhttp_port}?${common}&type=xhttp&path=${urlencode(main.xhttp_path || '/')}&mode=${urlencode(main.xhttp_mode || 'auto')}&core=xray#${urlencode(name + '-xhttp')}`
				});
		}
		if (hy2) {
			let no = !p.password ? 'the profile has no Hysteria2 password'
				: cert.error ? 'the certificate is not set up: ' + cert.error : nohost;
			let link = '';
			if (!no) {
				link = `hysteria2://${urlencode(p.password)}@${host}:${main.hysteria2_link_port || main.hysteria2_port}?sni=${urlencode(cert.server_name)}`;
				if (main.hysteria2_obfs)
					link += `&obfs=salamander&obfs-password=${urlencode(main.hysteria2_obfs)}`;
				link += `#${urlencode(name + '-hysteria2')}`;
			}
			push(links, no ? { transport: 'hysteria2', title: 'Hysteria2', error: no } : {
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
		return { log: syslog_tail(LOG, 200) };
	}
};

methods.config = {
	call: function() {
		return { config: readfile(CONF) ?? '', path: CONF };
	}
};

methods.restart = {
	call: function() {
		return restart(INIT);
	}
};

return { 'xtunnel-server': methods };
