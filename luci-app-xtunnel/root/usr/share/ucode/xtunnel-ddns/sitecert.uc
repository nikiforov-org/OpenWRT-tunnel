// xtunnel-ddns sitecert: which certificate the web server presents, and the move of the site to
// another name. The certificate in effect is that of the name in SITE_CERT; a change of the site's
// domain (another domain chosen, its hostname edited, a domain removed) never replaces it during
// an apply: the move job (/usr/libexec/xtunnel-ddns/move) gets a certificate for the new name and
// moves the site once that certificate is at least as trusted as the one in effect, the name
// points to this router and a browser has reached the router under the new name.
//
//   import { grade, in_effect, set_in_effect, target, apply_pending, move_state, set_move_state,
//            note_watch, watchers, confirm, confirmed } from 'xtunnel-ddns.sitecert';

'use strict';

import { readfile, writefile, mkdir, rename, access, stat, lsdir, unlink } from 'fs';
import { info } from 'xtunnel.x509';

const CERTS     = '/etc/ssl/xtunnel-ddns';
const SITE_CERT = '/etc/xtunnel-ddns/site.cert';
const MOVE      = '/tmp/xtunnel-ddns/move.json';
const SNAPSHOT  = '/var/run/rpcd/snapshot-files';   // exists while a LuCI apply waits for its confirmation
const WATCH     = '/tmp/xtunnel-ddns/watch';          // a file per address a page of this package is open under
const CONFIRM   = '/tmp/xtunnel-ddns/move.confirm';   // the name a browser reached the router under after a move

function valid_host(h) { return type(h) == 'string' && match(h, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/) != null; }

// the certificate installed for a name: grade 2 trusted (not a test certificate, valid now, issued
// for that name), 1 a test (staging) certificate otherwise as good, 0 none, expired or another name
function grade(host) {
	host = lc(host ?? '');
	let out = { host: host, grade: 0, cert: `${CERTS}/${host}/fullchain.pem`, key: `${CERTS}/${host}/key.pem` };
	if (!valid_host(host) || !access(out.cert) || !access(out.key)) return out;
	let i = info(readfile(out.cert));
	if (!i) return out;
	out.cn = lc(i.subject_cn ?? '');
	out.expires = i.not_after;
	out.staging = (index(i.issuer_cn ?? '', 'STAGING') >= 0 || index(i.issuer_o ?? '', 'STAGING') >= 0);
	if (out.cn == host && i.not_after && time() < i.not_after && (!i.not_before || i.not_before <= time()))
		out.grade = out.staging ? 1 : 2;
	return out;
}

// the name whose certificate the web server presents ('' while it is the router's own one)
function in_effect() {
	let h = lc(trim(readfile(SITE_CERT) ?? ''));
	return valid_host(h) ? h : '';
}

function set_in_effect(host) {
	mkdir('/etc/xtunnel-ddns', 0o755);
	writefile(`${SITE_CERT}.new`, (host ?? '') + '\n');
	rename(`${SITE_CERT}.new`, SITE_CERT);
}

// the domain the site is to answer to: { sid, host, staging } while the site is on, else null
function target(uci, cfg) {
	let main = uci.get_all(cfg, 'main') ?? {};
	if (main.site_enabled != '1' || !main.site_domain) return null;
	if (uci.get(cfg, main.site_domain) != 'domain') return null;
	let host = lc(trim(uci.get(cfg, main.site_domain, 'hostname') ?? ''));
	if (!valid_host(host)) return null;
	return { sid: main.site_domain, host: host, staging: uci.get(cfg, main.site_domain, 'staging') == '1' };
}

// a LuCI apply waits for the browser's confirmation (and is rolled back without it)
function apply_pending() {
	return length(lsdir(SNAPSHOT) ?? []) > 0;
}

function move_state() {
	let m = null;
	try { m = json(readfile(MOVE) ?? ''); } catch (e) { m = null; }
	return (type(m) == 'object') ? m : null;
}

function set_move_state(m) {
	mkdir('/tmp/xtunnel-ddns', 0o755);
	writefile(`${MOVE}.new`, sprintf('%J\n', { ...m, time: time() }));
	rename(`${MOVE}.new`, MOVE);
}

// a page of this package is open under HOST (a name or an address): its status calls touch a file
function note_watch(host) {
	host = lc(replace(replace(host ?? '', '[', ''), ']', ''));
	if (!match(host, /^[a-z0-9.:-]{1,253}$/) || index(host, '..') >= 0) return;
	mkdir('/tmp/xtunnel-ddns', 0o755);
	mkdir(WATCH, 0o755);
	writefile(`${WATCH}/${host}`, `${time()}\n`);
}

// the addresses pages were open under within the last AGE seconds, with the time of their last call
function watchers(age) {
	let out = {}, now = time();
	for (let n in lsdir(WATCH) ?? []) {
		let st = stat(`${WATCH}/${n}`);
		if (!st) continue;
		if (now - st.mtime <= age) out[n] = st.mtime;
		else if (now - st.mtime > 3600) unlink(`${WATCH}/${n}`);
	}
	return out;
}

// a browser reached the router under HOST after the move to it
function confirm(host) {
	mkdir('/tmp/xtunnel-ddns', 0o755);
	writefile(`${CONFIRM}.new`, `${lc(host ?? '')} ${time()}\n`);
	rename(`${CONFIRM}.new`, CONFIRM);
}

// whether a browser reached the router under HOST at or after the time SINCE
function confirmed(host, since) {
	let m = match(trim(readfile(CONFIRM) ?? ''), /^([^ ]+) ([0-9]+)$/);
	return m != null && m[1] == lc(host ?? '') && int(m[2]) >= since;
}

export { grade, in_effect, set_in_effect, target, apply_pending, move_state, set_move_state, note_watch, watchers,
         confirm, confirmed, valid_host, CERTS };
