'use strict';
// Shared helpers of luci-app-tunnel-client: the links of a profile (one per transport of the
// server page: TCP + XTLS-Vision, XHTTP, Hysteria2) into xray outbounds, the running xray and its
// active link, locks, IPv4 subnets.
//   import { PROTOCOLS, link_outbound } from 'tunnel-client.common';

import { popen, readfile, open } from 'fs';
import { connect } from 'ubus';

export const RUN = '/tmp/tunnel-client';
export const ACTIVE = `${RUN}/active`;          // "TAG PID": the link select applied to that xray process
export const PROTOCOLS = [ 'vision', 'xhttp', 'hysteria2' ];
export const TITLES = { vision: 'TCP + Vision', xhttp: 'XHTTP', hysteria2: 'Hysteria2' };

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

// an exclusive lock held until the process exits (flock: a clock change cannot make it look stale);
// null when another process holds it
export function lock(path) {
	let f = open(path, 'w');
	return f?.lock('xn') ? f : null;
};

// whether another process holds the lock of lock()
export function locked(path) {
	let f = open(path, 'r');
	if (!f) return false;
	let free = f.lock('sn');
	f.close();
	return !free;
};

let bus = null;

// the running xray of the tunnel packages (procd service "tunnel-xray") while its joined
// configuration holds this client's file, else null
export function instance() {
	if (index(split(readfile('/tmp/tunnel-xray/parts') ?? '', '\n'), '/etc/tunnel-client/config.json') < 0) return null;
	bus ??= connect();
	let inst = bus?.call('service', 'list', { name: 'tunnel-xray' })?.['tunnel-xray']?.instances?.xray;
	return (inst?.running == true) ? inst : null;
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
	bus ??= connect();
	let best = null, metric = null;
	for (let i in bus?.call('network.interface', 'dump')?.interface ?? []) {
		if (!i.up) continue;
		for (let r in i.route ?? [])
			if (r.target == '0.0.0.0' && r.mask == 0 && r.table == null && r.type == null && (metric == null || (r.metric ?? 0) < metric)) {
				best = i.interface;
				metric = r.metric ?? 0;
			}
	}
	return best;
};

// an IPv4 subnet or address -> "a.b.c.d/p" with the host bits cleared, or null
export function cidr(s) {
	let m = match(trim(s ?? ''), /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(\/([0-9]{1,2}))?$/);
	if (!m) return null;
	let p = (m[6] != null) ? int(m[6]) : 32, n = 0;
	if (p > 32) return null;
	for (let i = 1; i <= 4; i++) {
		let o = int(m[i]);
		if (o > 255) return null;
		n = n * 256 + o;
	}
	let size = 1;
	for (let i = 0; i < 32 - p; i++) size *= 2;
	n -= n % size;
	return sprintf('%d.%d.%d.%d/%d', n / 16777216 % 256, n / 65536 % 256, n / 256 % 256, n % 256, p);
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

// the link of one transport of a profile -> { outbound (an xray outbound without tag), host, port } or { error }
export function link_outbound(protocol, link) {
	let p = parse_link(link);
	if (protocol == 'hysteria2') {
		if (!p || (p.scheme != 'hysteria2' && p.scheme != 'hy2')) return { error: 'not a hysteria2:// link' };
		let o = hysteria2(p);
		return o.error ? o : { outbound: o.outbound, host: p.host, port: p.port };
	}
	if (!p || p.scheme != 'vless') return { error: 'not a vless:// link' };
	let o = vless(p, protocol);
	return o.error ? o : { outbound: o.outbound, host: p.host, port: p.port };
};
