'use strict';
// Shared helpers of the Tunnel > Clients packages: link parsing, conversion of links into xray
// outbounds, the runtime descriptors the client packages write for luci-app-tunnel-clients.
//   import { parse_link, vless_to_xray, hysteria2_to_xray } from 'tunnel-clients.common';

import { popen, readfile, writefile, mkdir, lsdir } from 'fs';

export const RUN   = '/tmp/tunnel-clients';         // runtime descriptors: <package>.json, state
export const SHARE = '/usr/share/tunnel-clients';   // static descriptors of the installed client packages

export function shq(s) {
	return "'" + replace(`${s ?? ''}`, "'", "'\\''") + "'";
};

export function exec(command) {
	let p = popen(command, 'r');
	if (p == null)
		return { code: -1, out: '' };
	let out = p.read('all') ?? '';
	return { code: p.close(), out: out };
};

export function urldecode(s) {
	return replace(`${s ?? ''}`, /%([0-9A-Fa-f][0-9A-Fa-f])/g, (m, h) => chr(hex(h)));
};

// scheme://userinfo@host:port[/][?query][#fragment] -> { scheme, user, host, port, query: {}, name }
export function parse_link(link) {
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
};

// A vless:// link -> { outbound, transport } (an xray outbound without tag) or { error }.
// Transports: tcp (with or without XTLS-Vision), xhttp, ws, grpc, httpupgrade; security: reality,
// tls or none. xray removed switching certificate checks off, so an insecure TLS link is refused.
export function vless_to_xray(p) {
	let q = p.query, net = q.type ?? 'tcp', sec = q.security ?? 'none';
	if (!match(p.user, /^[0-9a-fA-F-]{36}$/)) return { error: 'the UUID is missing' };
	let user = { id: p.user, encryption: q.encryption || 'none' };
	let stream = {};
	if (net == 'tcp' || net == 'raw') {
		if (q.headerType && q.headerType != 'none') return { error: 'TCP header obfuscation is not supported' };
		stream.network = 'tcp';
	}
	else if (net == 'xhttp' || net == 'splithttp') {
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
	else if (net == 'ws') {
		stream.network = 'ws';
		stream.wsSettings = { path: q.path || '/' };
		if (q.host) stream.wsSettings.host = q.host;
	}
	else if (net == 'grpc') {
		stream.network = 'grpc';
		stream.grpcSettings = { serviceName: q.serviceName || '' };
		if (q.mode == 'multi') stream.grpcSettings.multiMode = true;
	}
	else if (net == 'httpupgrade') {
		stream.network = 'httpupgrade';
		stream.httpupgradeSettings = { path: q.path || '/' };
		if (q.host) stream.httpupgradeSettings.host = q.host;
	}
	else return { error: `transport "${net}" is not supported (tcp, xhttp, ws, grpc, httpupgrade)` };
	if (q.flow) {
		if (stream.network != 'tcp') return { error: 'flow (XTLS-Vision) works only with the TCP transport' };
		user.flow = q.flow;
	}
	let sni = q.sni || q.serverName || '';
	if (sec == 'reality') {
		if (!q.pbk) return { error: 'the REALITY public key (pbk) is missing' };
		stream.security = 'reality';
		stream.realitySettings = { serverName: sni, fingerprint: q.fp || 'chrome', publicKey: q.pbk, shortId: q.sid ?? '' };
		if (q.spx) stream.realitySettings.spiderX = q.spx;
	}
	else if (sec == 'tls') {
		if (q.allowInsecure == '1' || q.insecure == '1')
			return { error: 'certificate checks cannot be switched off in xray: the server needs a valid certificate' };
		stream.security = 'tls';
		stream.tlsSettings = { serverName: sni || p.host, fingerprint: q.fp || 'chrome' };
		if (q.alpn) stream.tlsSettings.alpn = split(q.alpn, ',');
	}
	else if (sec == 'none')
		stream.security = 'none';
	else return { error: `security "${sec}" is not supported (reality, tls or none)` };
	let transport = (stream.network == 'tcp') ? (user.flow ? 'vision' : 'tcp') : stream.network;
	return {
		outbound: { protocol: 'vless', settings: { vnext: [ { address: p.host, port: p.port, users: [ user ] } ] }, streamSettings: stream },
		transport: transport
	};
};

// A hysteria2:// (hy2://) link -> { outbound, transport } (an xray outbound without tag) or { error }.
// A server with an untrusted certificate needs its SHA-256 fingerprint in the link (pinSHA256);
// Salamander obfuscation (obfs=salamander, obfs-password) is supported.
export function hysteria2_to_xray(p) {
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
	return {
		outbound: { protocol: 'hysteria', settings: { version: 2, address: p.host, port: p.port }, streamSettings: stream },
		transport: 'hysteria2'
	};
};

// the runtime descriptor a client package writes: { package, clients: [ { tag, name, enabled,
// transport, server_host, server_port, test_url, outbound, error } ] }
export function write_descriptor(pkg, data) {
	mkdir(RUN, 0o755);
	writefile(`${RUN}/${pkg}.json.tmp`, sprintf('%J\n', data));
	system(`mv -f ${shq(RUN + '/' + pkg + '.json.tmp')} ${shq(RUN + '/' + pkg + '.json')}`);
};

// every installed client package: its static descriptor merged with the runtime one
export function descriptors() {
	let out = [];
	for (let f in (lsdir(SHARE) ?? [])) {
		if (substr(f, -5) != '.json') continue;
		let st = null;
		try { st = json(readfile(`${SHARE}/${f}`) ?? ''); } catch (e) { st = null; }
		if (type(st) != 'object' || !st.package) continue;
		let rt = null;
		try { rt = json(readfile(`${RUN}/${st.package}.json`) ?? ''); } catch (e) { rt = null; }
		st.clients = (type(rt) == 'object' && type(rt.clients) == 'array') ? rt.clients : [];
		st.error = (type(rt) == 'object') ? (rt.error ?? '') : '';
		push(out, st);
	}
	return out;
};
