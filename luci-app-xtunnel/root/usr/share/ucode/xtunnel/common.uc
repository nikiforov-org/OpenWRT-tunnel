'use strict';
// The helpers of every part of luci-app-xtunnel (dynamic DNS, server, client), once.
//   import { shq, exec, log, … } from 'xtunnel.common';

import { popen, readfile, writefile, open, mkdir, rename, unlink, chmod, stat } from 'fs';
import { connect } from 'ubus';

export const XRAY = '/usr/bin/xray';
const CRONTAB = '/etc/crontabs/root';

export function shq(s) {
	return "'" + replace(`${s ?? ''}`, "'", "'\\''") + "'";
};

// a shell command: { code, out } with its standard output
export function exec(command) {
	let p = popen(command, 'r');
	if (p == null)
		return { code: -1, out: '' };
	let out = p.read('all') ?? '';
	return { code: p.close(), out: out };
};

// COMMAND in the background, detached: a session of its own, /dev/null for its standard descriptors and
// no other inherited one. Descriptor 1000 is the lock rc.common holds while an init script runs (a sync
// started by procd's reload trigger): a job that inherits it keeps the next reload of that init script
// waiting until the job ends (the measurement after a start of xray held the client's reload for ~40 s).
export function spawn(command) {
	system(`( exec 1000>&-; exec setsid sh -c ${shq(command)} ) </dev/null >/dev/null 2>&1 &`);
};

// a message in the system log under TAG
export function log(tag, msg) {
	system(`logger -t ${tag} ${shq(msg)}`);
};

// a configuration not applied: the reason in FILE (for the page) and in the system log under TAG
export function not_applied(tag, file, msg) {
	mkdir(replace(file, /\/[^\/]*$/, ''), 0o755);
	writefile(file, msg);
	log(tag, `not applied: ${msg}`);
};

// "YYYY-MM-DD HH:MM:SS" of the epoch time T (now without it); UTC: in UTC, else local time
export function stamp(t, utc) {
	let d = (utc ? gmtime : localtime)(t ?? time());
	return sprintf('%04d-%02d-%02d %02d:%02d:%02d', d.year, d.mon, d.mday, d.hour, d.min, d.sec);
};

// the last N lines of TEXT
export function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, length(lines) - n);
	return join('\n', lines);
};

// the last N lines of the system log that match the extended regular expression PATTERN
export function syslog_tail(pattern, n) {
	return tail(exec(`logread 2>/dev/null | grep -E ${shq(pattern)}`).out, n);
};

// a restart of the init script INIT for a page: { ok, log }
export function restart(init) {
	let r = exec(`${init} restart 2>&1`);
	return { ok: (r.code == 0), log: trim(r.out) };
};

// a uci list option as an array
export function list(v) {
	if (type(v) == 'array') return v;
	return (v == null || v == '') ? [] : [ v ];
};

// a uci boolean option, DFLT when it is not set
export function flag(v, dflt) {
	return (v == null || v == '') ? dflt : (v == '1');
};

// the JSON of PATH when it has the type of DFLT (an object for null), else DFLT
export function read_json(path, dflt) {
	let v = null;
	try { v = json(readfile(path) ?? ''); } catch (e) { v = null; }
	return (type(v) == (dflt == null ? 'object' : type(dflt))) ? v : dflt;
};

// a uci section name
export function valid_sid(s) {
	return type(s) == 'string' && match(s, /^[A-Za-z0-9_]{1,64}$/) != null;
};

// http(s)://host[:port]… -> { host, port, hostport }, or null
export function url_parts(url) {
	let m = match(url ?? '', /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[^:\/?#]+)(:([0-9]+))?/);
	if (!m) return null;
	let port = m[4] ? int(m[4]) : (m[1] == 'https' ? 443 : 80);
	return { host: m[2], port: port, hostport: `${m[2]}:${port}` };
};

// an exclusive lock held until the process exits or the handle is closed (flock: a clock change
// cannot make it look stale; 'e': the processes started meanwhile do not inherit it); WAIT: blocks until
// it is free, else null when another process holds it
export function lock(path, wait) {
	let f = open(path, 'we');
	return f?.lock(wait ? 'x' : 'xn') ? f : null;
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

// the connection to ubus of this process
export function ubus() {
	bus ??= connect();
	return bus;
};

// the instances of the procd service SERVICE ({} without one)
export function instances(service) {
	return ubus()?.call('service', 'list', { name: service })?.[service]?.instances ?? {};
};

// the running instance NAME of the procd service SERVICE (any instance without NAME), or null
export function running(service, name) {
	for (let n, i in instances(service))
		if ((name == null || n == name) && i.running && i.pid) return i;
	return null;
};

// the running xray of the parts (procd service "xtunnel-xray", see xray-service) while its joined
// configuration holds the file CONF of a part, else null
export function xray_instance(conf) {
	if (index(split(readfile('/tmp/xtunnel-xray/parts') ?? '', '\n'), conf) < 0) return null;
	return running('xtunnel-xray', 'xray');
};

// sets a uci option to VAL (an array for a list option; null or '' removes it); true when it changed
export function uset(uci, cfg, sec, opt, val) {
	let cur = uci.get(cfg, sec, opt);
	if (val == null || val == '' || (type(val) == 'array' && !length(val))) {
		if (cur == null) return false;
		uci.delete(cfg, sec, opt);
		return true;
	}
	if (type(val) == 'array' ? (type(cur) == 'array' && join('\n', cur) == join('\n', val)) : (cur == val)) return false;
	uci.set(cfg, sec, opt, val);
	return true;
};

// the firewall rule SECTION of /etc/config/firewall (loaded in UCI): RULE { name, proto, port } open from
// the zone wan, or no rule for null; true when it changed
export function fw_rule(uci, section, rule) {
	let had = (uci.get('firewall', section) == 'rule');
	if (!rule) {
		if (had) uci.delete('firewall', section);
		return had;
	}
	if (!had) uci.set('firewall', section, 'rule');
	let changed = !had;
	for (let o, v in { name: rule.name, src: 'wan', proto: rule.proto, dest_port: `${rule.port}`, target: 'ACCEPT', enabled: '1' })
		changed = uset(uci, 'firewall', section, o, v) || changed;
	return changed;
};

// the lines of root's crontab that carry TAG
export function cron_lines(tag) {
	return filter(split(readfile(CRONTAB) ?? '', '\n'), l => length(l) && index(l, tag) >= 0);
};

// a daily line for COMMAND, tagged with TAG: the one there is, or one at a random time
export function cron_daily(tag, command) {
	let have = cron_lines(tag);
	if (length(have)) return have[0];
	let r = readfile('/dev/urandom', 2) ?? '';
	return sprintf('%d %d * * * %s %s', length(r) > 1 ? ord(r, 0) % 60 : 23, length(r) > 1 ? ord(r, 1) % 24 : 4, command, tag);
};

// replaces the lines of root's crontab that carry TAG with LINES; the cron service restarts when they
// changed, and the crontab goes when no line is left (without one the cron service does not run).
// True when they changed.
export function set_cron(tag, lines) {
	let all = filter(split(readfile(CRONTAB) ?? '', '\n'), l => length(l));
	if (join('\n', filter(all, l => index(l, tag) >= 0)) == join('\n', lines)) return false;
	let rest = [ ...filter(all, l => index(l, tag) < 0), ...lines ];
	if (length(rest)) {
		mkdir('/etc/crontabs', 0o755);
		writefile(`${CRONTAB}.new`, join('\n', rest) + '\n');
		rename(`${CRONTAB}.new`, CRONTAB);
	}
	else unlink(CRONTAB);
	system('/etc/init.d/cron restart >/dev/null 2>&1');
	return true;
};

// writes TEXT to PATH (mode MODE) when it differs, after CHECK(the new file) found nothing wrong with it
// (it returns null, or the reason): 'same', 'written', or the reason
export function replace_checked(path, text, mode, check) {
	if (readfile(path) == text) {
		chmod(path, mode);
		return 'same';
	}
	let tmp = `${path}.new`;
	writefile(tmp, text);
	chmod(tmp, mode);
	let error = check ? check(tmp) : null;
	if (error) {
		unlink(tmp);
		return error;
	}
	rename(tmp, path);
	return 'written';
};

// xray's test of the configuration in PATH (ENV: variables for it): null when it accepts it, else the
// reason (the end of its last line)
export function xray_test(path, env) {
	let r = exec(`${env ?? ''} ${XRAY} run -test -format json -c ${shq(path)} 2>&1`);
	if (r.code == 0) return null;
	let lines = split(rtrim(r.out, '\n'), '\n'), last = split(lines[length(lines) - 1] ?? '', ' > ');
	return trim(last[length(last) - 1]) || `xray exit code ${r.code}`;
};

// the xray configuration CONFIG of a part (log TAG, its reason file ERROR) to the file PATH, when xray
// accepts it (ENV: variables for the test): 'same', 'written' or null (the reason in ERROR)
export function write_xray(tag, error, path, config, env) {
	mkdir(replace(path, /\/[^\/]*$/, ''), 0o700);
	if (stat(XRAY)?.mode == null) {
		not_applied(tag, error, 'xray is not installed (/usr/bin/xray of the package xtunnel-core is missing)');
		return null;
	}
	let r = replace_checked(path, sprintf('%.2J\n', config), 0o600, f => xray_test(f, env));
	if (r == 'written') log(tag, 'configuration written');
	else if (r != 'same') { not_applied(tag, error, `xray rejected the configuration: ${r}`); return null; }
	return r;
};

// the version an executable prints (with ARGS; the first group of RE), read again only when the
// executable changed (rpcd keeps its plugins loaded)
let versions = {};
export function version_of(path, args, re) {
	let st = stat(path), key = st ? `${st.mtime}/${st.size}` : null;
	if (versions[path]?.key != key) {
		let m = key ? match(exec(`${path} ${args} 2>/dev/null`).out, re) : null;
		versions[path] = { key: key, value: m ? m[1] : '' };
	}
	return versions[path].value;
};

export function xray_version() {
	return version_of(XRAY, 'version', /Xray ([0-9.]+)/);
};

// an X25519 key pair from xray, made (without PRIV) or derived from the private key PRIV (base64url):
// { private_key, public_key } in base64url, or null. xray prints the public key as "Password (PublicKey): …"
// (26.x), "Password: …" (25.x) or "Public key: …" (earlier).
export function x25519(priv) {
	let out = exec(`${XRAY} x25519${priv ? ' -i ' + shq(priv) : ''} 2>/dev/null`).out;
	let a = match(out, /Private ?[Kk]ey *: *([A-Za-z0-9_-]{43})/), b = match(out, /(Public ?[Kk]ey|Password)( *\([^)]*\))? *: *([A-Za-z0-9_-]{43})/);
	return (a && b) ? { private_key: a[1], public_key: b[3] } : null;
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

// ---- reverse access (xray's reverse proxy: a bridge on the client's router, a portal on the server's) ----

// the name of a profile's channel between the bridge and the portal: the UUID of the profile's VLESS
// link, which both routers know; it only names the channel inside the link
export function reverse_domain(uuid) {
	return `${lc(trim(uuid ?? ''))}.reverse.xtunnel`;
};

// an entry "LOCAL:HOST:PORT" of a list of ports: this router listens on LOCAL and the connection goes
// through the channel to HOST:PORT on the other router -> { port, host, target_port } or null
export function port_entry(e) {
	let m = match(trim(e ?? ''), /^([0-9]{1,5}):([A-Za-z0-9.-]+):([0-9]{1,5})$/);
	if (!m) return null;
	let port = int(m[1]), tport = int(m[3]);
	if (port < 1 || port > 65535 || tport < 1 || tport > 65535) return null;
	return { port: port, host: m[2], target_port: tport };
};

// an entry "ADDRESS[/PREFIX]:PORT[-PORT]" of what a bridge lets the other router reach -> { ip, port } or null
export function allow_entry(e) {
	let m = match(trim(e ?? ''), /^([0-9.\/]+):([0-9]{1,5}(-[0-9]{1,5})?)$/);
	if (!m) return null;
	let ip = cidr(m[1]);
	return ip ? { ip: ip, port: m[2] } : null;
};

// what a bridge lets the other router reach when its list is empty: this router's SSH and its web
// interface (the site, with the REALITY transport in front of it on 443 or uhttpd itself)
export const REVERSE_ALLOW = [ '127.0.0.1:22', '127.0.0.1:443' ];
