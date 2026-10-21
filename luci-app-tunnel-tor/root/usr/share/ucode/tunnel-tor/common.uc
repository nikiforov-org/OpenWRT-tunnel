'use strict';
// Shared helpers of luci-app-tunnel-tor: the client keys (x25519, base32 as tor expects them), the
// running tor of the stock service, and tor's control port as the configuration in effect writes it.
//   import { tor_instance, control, bootstrap_phase } from 'tunnel-tor.common';

import { popen, readfile, writefile, unlink, chmod, mkdir } from 'fs';
import { connect } from 'ubus';

export const CONF = '/etc/tunnel-tor/torrc';
export const RUN = '/tmp/tunnel-tor';
const STOCK_DATA = '/var/lib/tor';

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

export function valid_key(s) {
	return type(s) == 'string' && match(s, /^[A-Z2-7]{52}$/) != null;
};

// the public key of a base32 private key, through openssl (the DER prefix of an x25519 private key)
export function public_key(priv) {
	if (!valid_key(priv)) return '';
	let raw = base32_decode(priv);
	if (raw == null || length(raw) != 32) return '';
	mkdir(RUN, 0o700);
	let pem = `${RUN}/key-${time()}.pem`;
	writefile(pem, "-----BEGIN PRIVATE KEY-----\n" + b64enc(hexdec('302e020100300506032b656e04220420') + raw) + "\n-----END PRIVATE KEY-----\n");
	chmod(pem, 0o600);
	let r = exec(`openssl pkey -in ${shq(pem)} -pubout -outform DER 2>/dev/null`);
	unlink(pem);
	if (r.code != 0 || length(r.out) < 32) return '';
	return base32(substr(r.out, length(r.out) - 32));
};

let bus = null;

// the running tor of the stock service (procd service "tor"), or null; another tor process on the
// router (a second service, a test client) does not count
export function tor_instance() {
	bus ??= connect();
	for (let n, i in bus?.call('service', 'list', { name: 'tor' })?.tor?.instances ?? {})
		if (i.running && i.pid) return i;
	return null;
};

function hexstr(bin) {
	let out = '';
	for (let i = 0; i < length(bin); i++) out += sprintf('%02x', ord(bin, i));
	return out;
}

// the commands sent to tor's control port (127.0.0.1, the port file and the cookie of the
// configuration in effect) after AUTHENTICATE; tor's answer, or null without a port or cookie.
// busybox nc has no timeout option: it is killed after 10 seconds when tor does not close.
export function control(commands) {
	let conf = readfile(CONF) ?? '';
	let dd = match(conf, /\nDataDirectory ([^\n]+)/), pf = match(conf, /\nControlPortWriteToFile ([^\n]+)/);
	let datadir = dd ? dd[1] : STOCK_DATA;
	let m = match(readfile(pf ? pf[1] : `${datadir}/control.port`) ?? '', /PORT=127\.0\.0\.1:([0-9]+)/);
	let cookie = readfile(`${datadir}/control_auth_cookie`);
	if (!m || cookie == null || length(cookie) != 32) return null;
	let req = `AUTHENTICATE ${hexstr(cookie)}\r\n` + join('', map(commands, c => `${c}\r\n`)) + 'QUIT\r\n';
	return exec(`printf %s ${shq(req)} | nc 127.0.0.1 ${m[1]} 2>/dev/null & n=$!; ( sleep 10; kill $n ) >/dev/null 2>&1 & k=$!; wait $n 2>/dev/null; kill $k 2>/dev/null`).out;
};

// { percent, text } of tor's bootstrap (text: what it does while not done), or null
export function bootstrap_phase() {
	let m = match(control([ 'GETINFO status/bootstrap-phase' ]) ?? '', /PROGRESS=([0-9]+) TAG=([a-z_]+) SUMMARY="([^"]*)"/);
	return m ? { percent: int(m[1]), text: (m[2] == 'done') ? '' : m[3] } : null;
};
