'use strict';
// Shared helpers of the client part of luci-app-xtunnel: the links of a profile (one per transport of the
// server page: TCP + XTLS-Vision, XHTTP, Hysteria2) into xray
// outbounds, the running xray and its active link, the uplink.
//   import { PROTOCOLS, link_outbound } from 'xtunnel-client.common';

import { readfile } from 'fs';
import { ubus, xray_instance } from 'xtunnel.common';

const CFG = 'xtunnel-client';

export const RUN = '/tmp/xtunnel-client';
export const ACTIVE = `${RUN}/active`;          // "TAG PID": the link select applied to that xray process
export const PROTOCOLS = [ 'vision', 'xhttp', 'hysteria2' ];
export const TITLES = { vision: 'TCP + Vision', xhttp: 'XHTTP', hysteria2: 'Hysteria2' };

// the running xray while it has this client's configuration, else null
export function instance() {
	return xray_instance('/etc/xtunnel-client/config.json');
};

// the active link of that xray: the one select applied to this process, else the one of the
// balancer's selector, which a start of xray uses (state.active of the configuration in effect)
export function active_link(inst, state) {
	if (!inst) return '';
	let f = split(trim(readfile(ACTIVE) ?? ''), ' ');
	return (length(f[0]) && int(f[1]) == inst.pid) ? f[0] : `${state?.active ?? ''}`;
};

// the interface the router's IPv4 default route goes through (the lowest metric of the interfaces
// that are up, as netifd reports them; routes of other tables or types, such as this client's
// local route in table 2222, do not count), or null
export function uplink() {
	let best = null, metric = null;
	for (let i in ubus()?.call('network.interface', 'dump')?.interface ?? []) {
		if (!i.up) continue;
		for (let r in i.route ?? [])
			if (r.target == '0.0.0.0' && r.mask == 0 && r.table == null && r.type == null && (metric == null || (r.metric ?? 0) < metric)) {
				best = i.interface;
				metric = r.metric ?? 0;
			}
	}
	return best;
};

function urldecode(s) {
	return replace(`${s ?? ''}`, /%([0-9A-Fa-f][0-9A-Fa-f])/g, (m, h) => chr(hex(h)));
}

// scheme://userinfo@host:port[/][?query][#fragment] -> { scheme, user, host, port, query: {}, name }
function parse_link(link) {
	let m = match(trim(link ?? ''), /^([a-z0-9]+):\/\/([^@\/?#]*)@(\[[0-9a-fA-F:.]+\]|[^:\/?#]+):([0-9]+)\/?(\?[^#]*)?(#.*)?$/);
	if (!m) return null;
	let q = {};
	for (let kv in split(substr(m[5] ?? '?', 1), '&')) {
		if (!length(kv)) continue;
		let eq = index(kv, '=');
		if (eq < 0) q[urldecode(kv)] = '';
		else q[urldecode(substr(kv, 0, eq))] = urldecode(replace(substr(kv, eq + 1), '+', ' '));
	}
	let host = m[3];
	if (substr(host, 0, 1) == '[') host = substr(host, 1, length(host) - 2);
	let port = int(m[4]);
	if (port < 1 || port > 65535) return null;
	return { scheme: m[1], user: urldecode(m[2]), host: host, port: port, query: q, name: trim(urldecode(substr(m[6] ?? '#', 1))) };
}

// the security part of a VLESS link: REALITY or TLS (xray has no switch for an unchecked certificate)
function vless_security(q, host, stream) {
	let sec = q.security ?? 'none', sni = q.sni || q.serverName || '';
	if (sec == 'reality') {
		if (!q.pbk) return 'the REALITY public key (pbk) is missing';
		stream.security = 'reality';
		stream.realitySettings = { serverName: sni, fingerprint: q.fp || 'chrome', publicKey: q.pbk, shortId: q.sid ?? '' };
		if (q.spx) stream.realitySettings.spiderX = q.spx;
		return null;
	}
	if (sec == 'tls') {
		if (q.allowInsecure == '1' || q.insecure == '1')
			return 'certificate checks cannot be switched off in xray: the server needs a valid certificate';
		stream.security = 'tls';
		stream.tlsSettings = { serverName: sni || host, fingerprint: q.fp || 'chrome' };
		if (q.alpn) stream.tlsSettings.alpn = split(q.alpn, ',');
		return null;
	}
	return `security "${sec}" is not supported (reality or tls)`;
}

function vless(p, protocol) {
	let q = p.query, net = q.type ?? 'tcp';
	if (!match(p.user, /^[0-9a-fA-F-]{36}$/)) return { error: 'the UUID is missing' };
	let user = { id: p.user, encryption: q.encryption || 'none' };
	let stream = {};
	if (protocol == 'vision') {
		if (net != 'tcp' && net != 'raw') return { error: `this is a VLESS link over "${net}", not TCP + XTLS-Vision` };
		if (q.flow != 'xtls-rprx-vision') return { error: 'the link has no flow=xtls-rprx-vision' };
		if (q.headerType && q.headerType != 'none') return { error: 'TCP header obfuscation is not supported' };
		stream.network = 'tcp';
		user.flow = q.flow;
	}
	else {
		if (net != 'xhttp' && net != 'splithttp') return { error: `this is a VLESS link over "${net}", not XHTTP` };
		stream.network = 'xhttp';
		stream.xhttpSettings = { path: q.path || '/', mode: q.mode || 'auto' };
		if (q.host) stream.xhttpSettings.host = q.host;
		if (q.extra) {
			let extra = null;
			try { extra = json(q.extra); } catch (e) { extra = null; }
			if (type(extra) != 'object') return { error: 'the XHTTP "extra" parameter is not a JSON object' };
			stream.xhttpSettings.extra = extra;
		}
	}
	let err = vless_security(q, p.host, stream);
	if (err) return { error: err };
	// a dead connection (the uplink or its address changed) is closed within about a minute: keepalive
	// probes after 30 s without traffic, closed after 30 s of unacknowledged data; the reverse channel's
	// bridge then connects again at once
	stream.sockopt = { tcpKeepAliveIdle: 30, tcpKeepAliveInterval: 10, tcpUserTimeout: 30000 };
	return { outbound: { protocol: 'vless', settings: { vnext: [ { address: p.host, port: p.port, users: [ user ] } ] }, streamSettings: stream } };
}

// A server with a certificate that does not verify needs its SHA-256 fingerprint in the link
// (pinSHA256); Salamander obfuscation (obfs=salamander, obfs-password) is supported.
function hysteria2(p) {
	let q = p.query;
	if (!length(p.user)) return { error: 'the password is missing' };
	let tls = { serverName: q.sni || p.host, alpn: [ 'h3' ] };
	let pin = lc(replace(q.pinSHA256 ?? '', /:/g, ''));
	if (length(pin)) {
		if (!match(pin, /^[0-9a-f]{64}$/)) return { error: 'pinSHA256 must be a SHA-256 fingerprint (64 hex digits)' };
		tls.pinnedPeerCertSha256 = pin;
	}
	else if (q.insecure == '1')
		return { error: 'the server certificate is not trusted (insecure=1): add pinSHA256=<SHA-256 of the certificate> to the link' };
	let stream = { network: 'hysteria', security: 'tls', tlsSettings: tls, hysteriaSettings: { version: 2, auth: p.user } };
	if (q.obfs == 'salamander') {
		if (!length(q['obfs-password'] ?? '')) return { error: 'the obfuscation password (obfs-password) is missing' };
		stream.finalmask = { udp: [ { type: 'salamander', settings: { password: q['obfs-password'] } } ] };
	}
	else if (q.obfs && q.obfs != 'none')
		return { error: `obfuscation "${q.obfs}" is not supported (salamander)` };
	return { outbound: { protocol: 'hysteria', settings: { version: 2, address: p.host, port: p.port }, streamSettings: stream } };
}

// the link of one transport of a profile -> { outbound (an xray outbound without tag), host, port }
// or { error }
export function link_outbound(protocol, link) {
	let p = parse_link(link);
	if (protocol == 'hysteria2') {
		if (!p || (p.scheme != 'hysteria2' && p.scheme != 'hy2')) return { error: 'not a hysteria2:// link' };
		let o = hysteria2(p);
		return o.error ? o : { outbound: o.outbound, host: p.host, port: p.port };
	}
	if (!p || p.scheme != 'vless') return { error: 'not a vless:// link' };
	let o = vless(p, protocol);
	if (o.error) return o;
	return { outbound: o.outbound, host: p.host, port: p.port };
};

// ---- the profiles of /etc/config/xtunnel-client ----

// every link of the profiles: { tag, profile, profile_name, protocol, title, enabled, server_host,
// server_port, test_url, outbound | error }; the tag is "<profile section>-<protocol>": the balancer of
// the active link selects every outbound whose tag starts with its selector, so no tag may start with
// another.
export function profile_links(uci) {
	let out = [];
	uci.foreach(CFG, 'profile', function(s) {
		let sid = s['.name'], name = trim(s.name ?? '') || sid, on = (s.enabled != '0');
		for (let proto in PROTOCOLS) {
			let link = trim(s[proto] ?? '');
			if (!length(link)) continue;
			let o = link_outbound(proto, link);
			push(out, { tag: `${sid}-${proto}`, profile: sid, profile_name: name, protocol: proto, title: TITLES[proto],
			            enabled: on, server_host: o.host ?? '', server_port: o.port ?? 0,
			            test_url: trim(s.test_url ?? ''), outbound: o.outbound, error: o.error ?? '' });
		}
	});
	return out;
};

// the links in use: of an enabled profile, without an error
export function in_use(l) {
	return l.enabled && !l.error && type(l.outbound) == 'object';
};
