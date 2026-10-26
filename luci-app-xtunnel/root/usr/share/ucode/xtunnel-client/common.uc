'use strict';
// Shared helpers of the client part of luci-app-xtunnel: the links of a profile (one per transport of the
// server page: TCP + XTLS-Vision, XHTTP, Hysteria2, and the one through Tor) into xray
// outbounds, the running xray and its active link, the uplink, IPv4 subnets.
//   import { PROTOCOLS, link_outbound } from 'xtunnel-client.common';

import { readfile, access } from 'fs';
import { ubus, xray_instance } from 'xtunnel.common';
import { target } from 'xtunnel-ddns.sitecert';

const CFG = 'xtunnel-client';
const TOR = '/usr/sbin/tor';

export const RUN = '/tmp/xtunnel-client';
export const ACTIVE = `${RUN}/active`;          // "TAG PID": the link select applied to that xray process
export const PROTOCOLS = [ 'vision', 'xhttp', 'hysteria2', 'vision_tor' ];   // vision_tor: the link through Tor
export const TITLES = { vision: 'TCP + Vision', xhttp: 'XHTTP', hysteria2: 'Hysteria2',
                        vision_tor: 'through Tor', tor: 'Tor without a server' };
// the outbound "tor": the SOCKS port of the router's tor (tor's default: the stock torrc sets none). The links
// through Tor are dialed through it (sockopt.dialerProxy); the link "Tor without a server" (main.tor_exit) is
// this outbound itself, the LAN out of the exit relays of the Tor network
export const TOR_OUTBOUND = { tag: 'tor', protocol: 'socks', settings: { address: '127.0.0.1', port: 9050 } };

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

// the client authorization key of an onion service: the line of the Tor key of a server profile
// ("<56 characters>:descriptor:x25519:<52 characters>") or the key alone ->
// { address (without ".onion", '' for the key alone), key } or null
export function onion_key(s) {
	s = trim(s ?? '');
	let m = match(s, /^([A-Za-z2-7]{56})(\.onion)?:descriptor:x25519:([A-Za-z2-7]{52})$/);
	if (m) return { address: lc(m[1]), key: uc(m[3]) };
	m = match(s, /^([A-Za-z2-7]{52})$/);
	return m ? { address: '', key: uc(m[1]) } : null;
};

// a name of the Tor network: an onion address or a name that a tor client maps to one
export function is_onion(host) {
	return match(lc(host ?? ''), /\.onion$/) != null;
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

// the link of one transport of a profile -> { outbound (an xray outbound without tag), host, port, tor }
// or { error }. A link through Tor is dialed through the SOCKS port of the router's tor (the outbound
// "tor"): to an onion address, or to any other address from a Tor exit. Tor carries TCP streams only.
export function link_outbound(protocol, link) {
	let p = parse_link(link);
	if (protocol == 'hysteria2') {
		if (!p || (p.scheme != 'hysteria2' && p.scheme != 'hy2')) return { error: 'not a hysteria2:// link' };
		if (is_onion(p.host)) return { error: 'an .onion address is reached only through Tor, which carries no UDP: Hysteria2 cannot use it' };
		let o = hysteria2(p);
		return o.error ? o : { outbound: o.outbound, host: p.host, port: p.port, tor: false };
	}
	let tor = (protocol == 'vision_tor');
	if (!p || p.scheme != 'vless') return { error: 'not a vless:// link' };
	if (!tor && is_onion(p.host)) return { error: 'an .onion address is reached only through Tor: this link belongs in the field through Tor' };
	if (tor && is_onion(p.host) && !match(lc(p.host), /^[a-z2-7]{56}\.onion$/))
		return { error: `${p.host} is not an onion address: the link needs the 56-character address the server page gives` };
	if (tor && index(split(lc(p.query.alpn ?? ''), ','), 'h3') >= 0) return { error: 'HTTP/3 (alpn=h3) runs over UDP, which Tor does not carry' };
	let o = vless(p, tor ? substr(protocol, 0, index(protocol, '_')) : protocol);
	if (o.error) return o;
	if (tor) o.outbound.streamSettings.sockopt = { dialerProxy: 'tor' };
	return { outbound: o.outbound, host: p.host, port: p.port, tor: tor };
};

// ---- the profiles of /etc/config/xtunnel-client (sync, and the Tor part for the client keys) ----

// every link of the profiles: { tag, profile, profile_name, protocol, title, enabled, tor, tor_on,
// server_host, server_port, test_url, outbound | error }; the tag is "<profile section>-<protocol>", for
// the link through Tor "<profile section>-tor": the balancer of the active link selects every
// outbound whose tag starts with its selector, so no tag may start with another.
// A link through Tor (tor) is used while its profile has "Through Tor" on (tor_on); without tor on
// the router such a link is marked with the reason.
export function profile_links(uci) {
	let out = [], have_tor = (access(TOR, 'x') == true && access('/etc/config/tor') == true);
	uci.foreach(CFG, 'profile', function(s) {
		let sid = s['.name'], name = trim(s.name ?? '') || sid, on = (s.enabled != '0'), tor_on = (s.tor == '1');
		for (let proto in PROTOCOLS) {
			let link = trim(s[proto] ?? '');
			if (!length(link)) continue;
			let o = link_outbound(proto, link), tor = (index(proto, '_tor') > 0);
			if (tor && on && tor_on && !o.error && !have_tor)
				o.error = 'tor is not installed on this router (/usr/sbin/tor of the package xtunnel-core)';
			push(out, { tag: tor ? `${sid}-tor` : `${sid}-${proto}`, profile: sid, profile_name: name, protocol: proto, title: TITLES[proto],
			            enabled: on, tor: tor, tor_on: tor_on, server_host: o.host ?? '', server_port: o.port ?? 0,
			            test_url: trim(s.test_url ?? ''), outbound: o.outbound, error: o.error ?? '' });
		}
	});
	// measured through Tor with cgi-bin/speed of the site this router serves (the Dynamic DNS page), or main.tor_test_url
	if (uci.get(CFG, 'main', 'tor_exit') == '1') {
		let url = trim(uci.get(CFG, 'main', 'tor_test_url') ?? ''), site = (!url && uci.load('xtunnel-ddns')) ? target(uci, 'xtunnel-ddns') : null;
		if (site) {
			let port = int(uci.get('xtunnel-ddns', 'main', 'site_port') ?? 443) || 443;
			url = `https://${site.host}${port == 443 ? '' : ':' + port}/cgi-bin/speed?bytes=20000000`;
		}
		push(out, { tag: TOR_OUTBOUND.tag, profile: '', profile_name: 'Tor', protocol: 'tor', title: TITLES.tor,
		            enabled: true, tor: true, tor_on: true, server_host: '', server_port: 0, test_url: url, outbound: TOR_OUTBOUND,
		            error: !have_tor ? 'tor is not installed on this router (/usr/sbin/tor of the package xtunnel-core)'
		                : !url ? 'no URL for its speed test: serve a site with a domain on the Dynamic DNS page, or enter the URL of cgi-bin/speed of one of your sites' : '' });
	}
	return out;
};

// the links in use: of an enabled profile, through Tor only with "Through Tor" on, without an error
export function in_use(l) {
	return l.enabled && (!l.tor || l.tor_on) && !l.error && type(l.outbound) == 'object';
};

// The client keys of the onion services that the links through Tor go to, one file per profile for
// tor's ClientOnionAuthDir: { "<profile section>.auth_private": "<address>:descriptor:x25519:<key>" }.
// The key is the line of the Tor key that "Links" of a profile on the Server page of the server router
// shows (or the key alone, for the one onion address of the links); a key that does not fit the links
// marks them with the reason.
export function onion_keys(uci, links) {
	let files = {};
	uci.foreach(CFG, 'profile', function(s) {
		let sid = s['.name'], raw = trim(s.tor_key ?? '');
		let used = filter(links, l => l.profile == sid && l.tor && in_use(l));
		if (!length(used) || !length(raw)) return;
		let addr_of = l => (match(lc(l.server_host), /^([a-z2-7]{56})\.onion$/) ?? [])[1];
		let addrs = [];
		for (let l in used) { let a = addr_of(l); if (a && index(addrs, a) < 0) push(addrs, a); }
		if (!length(addrs)) return;                      // no onion address among the links: no key needed
		let k = onion_key(raw);
		if (!k) {
			for (let l in used) l.error = 'the onion service key is not understood: paste the line of the Tor key from "Links" of a profile on the Server page of the server router';
			return;
		}
		let addr = k.address || ((length(addrs) == 1) ? addrs[0] : '');
		if (!addr) {
			for (let l in used) l.error = 'the key alone fits one onion address, the links go to several: paste the whole line of the Tor key';
			return;
		}
		for (let l in used) {
			let a = addr_of(l);
			if (a && a != addr) l.error = `the onion service key is for ${addr}.onion, this link goes to ${l.server_host}`;
		}
		files[`${sid}.auth_private`] = `${addr}:descriptor:x25519:${k.key}\n`;
	});
	return files;
};
