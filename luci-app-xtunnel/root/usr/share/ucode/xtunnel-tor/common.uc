'use strict';
// The Tor part's helpers: the client keys (x25519, base32 as tor expects them, made and derived by xray)
// and tor's control port as the configuration in effect writes it.
//   import { control, bootstrap_phase } from 'xtunnel-tor.common';

import { readfile } from 'fs';
import { shq, exec, list, x25519 } from 'xtunnel.common';

export const CONF = '/etc/xtunnel-tor/torrc';
export const RUN = '/tmp/xtunnel-tor';
const STOCK_DATA = '/var/lib/tor';

export function base32(bytes) {
	const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let out = '', bits = 0, val = 0;
	for (let i = 0; i < length(bytes); i++) {
		val = ((val << 8) | ord(bytes, i)) & 0x1fff;
		bits += 8;
		while (bits >= 5) { out += substr(A, (val >> (bits - 5)) & 31, 1); bits -= 5; }
	}
	if (bits > 0) out += substr(A, (val << (5 - bits)) & 31, 1);
	return out;
};

export function base32_decode(s) {
	const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let out = '', bits = 0, val = 0;
	for (let i = 0; i < length(s); i++) {
		let v = index(A, uc(substr(s, i, 1)));
		if (v < 0) return null;
		val = ((val << 5) | v) & 0x1fff;
		bits += 5;
		if (bits >= 8) { out += chr((val >> (bits - 8)) & 255); bits -= 8; }
	}
	return out;
};

// the names a tor client can map to the onion address (MapAddress NAME.onion ADDRESS), of the uci list V
export function aliases(v) {
	let out = [];
	for (let a in list(v)) {
		a = lc(trim(a));
		if (match(a, /^[a-z0-9_-]{1,63}$/) && !(a in out)) push(out, a);
	}
	return out;
};

// a bridge line without the "Bridge " prefix: "transport address:port fingerprint …" or "address:port fingerprint"
export function valid_bridge(line) {
	return match(line, /^(obfs4|snowflake|meek_lite|webtunnel) [^ ]+:[0-9]+ [0-9A-Fa-f]{40}( [^ ]+)*$/) != null
	    || match(line, /^[^ ]+:[0-9]+ [0-9A-Fa-f]{40}$/) != null;
};

export function valid_key(s) {
	return type(s) == 'string' && match(s, /^[A-Z2-7]{52}$/) != null;
};

// base64url without padding (xray's form of x25519 keys) <-> raw bytes
function b64url(raw) {
	return replace(replace(replace(b64enc(raw), /\+/g, '-'), /\//g, '_'), /=+$/, '');
}

function b64url_decode(s) {
	s = replace(replace(s, /-/g, '+'), /_/g, '/');
	while (length(s) % 4) s += '=';
	return b64dec(s);
}

// the public key of a base32 private key: x25519 is the same curve for tor's client keys and for
// REALITY, so xray derives it (the same result as openssl's x25519)
export function public_key(priv) {
	let raw = valid_key(priv) ? base32_decode(priv) : null;
	let k = (raw != null && length(raw) == 32) ? x25519(b64url(raw)) : null;
	let pub = k ? b64url_decode(k.public_key) : null;
	return (pub != null && length(pub) == 32) ? base32(pub) : '';
};

// a new client key pair from xray: { private_key, public_key } in base32, or null
export function keypair() {
	let k = x25519();
	let priv = k ? b64url_decode(k.private_key) : null, pub = k ? b64url_decode(k.public_key) : null;
	return (priv != null && pub != null && length(priv) == 32 && length(pub) == 32) ? { private_key: base32(priv), public_key: base32(pub) } : null;
};

function hexstr(bin) {
	let out = '';
	for (let i = 0; i < length(bin); i++) out += sprintf('%02x', ord(bin, i));
	return out;
}

// the commands sent to tor's control port (127.0.0.1, the port file and the cookie of the
// configuration in effect) after AUTHENTICATE; tor's answer, or null without a port or cookie.
// busybox nc has no timeout option: it is killed after TIMEOUT seconds (default 10) when tor does
// not close.
export function control(commands, timeout) {
	let conf = readfile(CONF) ?? '';
	let dd = match(conf, /\nDataDirectory ([^\n]+)/), pf = match(conf, /\nControlPortWriteToFile ([^\n]+)/);
	let datadir = dd ? dd[1] : STOCK_DATA;
	let m = match(readfile(pf ? pf[1] : `${datadir}/control.port`) ?? '', /PORT=127\.0\.0\.1:([0-9]+)/);
	let cookie = readfile(`${datadir}/control_auth_cookie`);
	if (!m || cookie == null || length(cookie) != 32) return null;
	let req = `AUTHENTICATE ${hexstr(cookie)}\r\n` + join('', map(commands, c => `${c}\r\n`)) + 'QUIT\r\n';
	return exec(`printf %s ${shq(req)} | nc 127.0.0.1 ${m[1]} 2>/dev/null & n=$!; ( sleep ${int(timeout ?? 10)}; kill $n ) >/dev/null 2>&1 & k=$!; wait $n 2>/dev/null; kill $k 2>/dev/null`).out;
};

// { percent, text } of tor's bootstrap (text: what it does while not done), or null; tor's answer is
// waited for at most TIMEOUT seconds (it can take seconds while tor loads its directory)
export function bootstrap_phase(timeout) {
	let m = match(control([ 'GETINFO status/bootstrap-phase' ], timeout) ?? '', /PROGRESS=([0-9]+) TAG=([a-z_]+) SUMMARY="([^"]*)"/);
	return m ? { percent: int(m[1]), text: (m[2] == 'done') ? '' : m[3] } : null;
};
