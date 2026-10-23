// xtunnel-ddns login: logs a user in to LuCI on behalf of a site's login page, with a brake
// on password guessing.
//
//   import { login } from 'xtunnel-ddns.login';
//
//   let result = login({ username: 'root', password: '…', client: '<ip address>', https: true });
//
//   result = { cookie: 'sysauth_https=<sid>; path=/cgi-bin/luci/; …' }  logged in: send the
//                                                                     cookie, redirect to LuCI
//          | { error: 'throttled', wait: <seconds> }                  the client must wait
//          | { error: 'denied' }                                      wrong name or password
//
// The session is created the way LuCI does it (rpcd "session login", then the token LuCI
// expects in the session), so the browser ends up logged in exactly as through LuCI's form.
//
// Failures are remembered per client address in /tmp/xtunnel-ddns/login/<address>: after
// FREE_ATTEMPTS failures in a row the client has to wait FIRST_DELAY seconds, doubling with
// every further failure up to MAX_DELAY. A successful login clears the record, a day without a
// failure forgets it, and at most MAX_RECORDS clients are kept (the oldest go first). All clients
// together may fail at most GLOBAL_LIMIT times per minute (file "_all").

'use strict';

import { open, readfile, writefile, unlink, mkdir, lsdir, stat } from 'fs';
import { connect } from 'ubus';
import { cursor } from 'uci';
import { openlog, syslog, LOG_PID, LOG_USER, LOG_INFO, LOG_WARNING } from 'log';

const DIR           = '/tmp/xtunnel-ddns/login';
const FREE_ATTEMPTS = 3;
const FIRST_DELAY   = 30;
const MAX_DELAY     = 900;
const GLOBAL_LIMIT  = 20;
const MAX_RECORDS   = 500;    // clients remembered at most (a file each in /tmp, that is in memory)
const KEEP          = 86400;  // a client's failures are remembered for a day after its last one
const COOKIE_PATH   = '/cgi-bin/luci/';   // the path LuCI itself uses, so the two never coexist

function record_path(client) {
	return `${DIR}/${replace(client ?? '', /[^0-9a-fA-F.:]/g, '') || 'unknown'}`;
}

function read_record(path) {
	let text = readfile(path);
	return text ? json(text) : {};
}

function write_record(path, record) {
	writefile(path, sprintf('%J', record));
}

// seconds the client still has to wait before another attempt, or 0
function wait_time(client) {
	let now = time();
	let record = read_record(record_path(client));
	if (record.until > now)
		return record.until - now;
	let all = read_record(`${DIR}/_all`);
	if (all.minute == now / 60 && all.failures >= GLOBAL_LIMIT)
		return 60 - now % 60;
	return 0;
}

// forgets clients without a failure for KEEP seconds, and the oldest ones beyond MAX_RECORDS
function tidy(now) {
	let files = [];
	for (let name in lsdir(DIR) ?? []) {
		if (name == '_all') continue;
		let st = stat(`${DIR}/${name}`);
		if (!st) continue;
		if (now - st.mtime > KEEP) unlink(`${DIR}/${name}`);
		else push(files, { name: name, mtime: st.mtime });
	}
	if (length(files) <= MAX_RECORDS) return;
	files = sort(files, (a, b) => a.mtime - b.mtime);
	for (let i = 0; i < length(files) - MAX_RECORDS; i++) unlink(`${DIR}/${files[i].name}`);
}

function note_failure(client) {
	let now = time();
	tidy(now);
	let path = record_path(client);
	let record = read_record(path);
	record.failures = (record.failures ?? 0) + 1;
	if (record.failures >= FREE_ATTEMPTS)
		record.until = now + min(FIRST_DELAY * (1 << min(record.failures - FREE_ATTEMPTS, 10)), MAX_DELAY);
	write_record(path, record);
	let all = read_record(`${DIR}/_all`);
	if (all.minute != now / 60)
		all = { minute: now / 60, failures: 0 };
	all.failures++;
	write_record(`${DIR}/_all`, all);
}

// a LuCI session for the credentials, or null
function create_session(username, password) {
	let ubus = connect();
	let configured = cursor().get('luci', 'sauth', 'sessiontime');
	let session = ubus.call('session', 'login', {
		username: username,
		password: password,
		timeout: configured ? +configured : null
	});
	if (type(session?.ubus_rpc_session) != 'string')
		return null;
	ubus.call('session', 'set', {
		ubus_rpc_session: session.ubus_rpc_session,
		values: { token: hexenc(open('/dev/urandom', 'r').read(8)) }
	});
	return session;
}

function login(request) {
	let username = request.username ?? '', client = request.client ?? '';
	mkdir('/tmp/xtunnel-ddns', 0o755);
	mkdir(DIR, 0o700);
	openlog('xtunnel-ddns', LOG_PID, LOG_USER);
	let wait = wait_time(client);
	if (wait > 0)
		return { error: 'throttled', wait };
	let session = create_session(username, request.password ?? '');
	if (!session) {
		note_failure(client);
		syslog(LOG_WARNING, `failed login for ${username} from ${client}`);
		return { error: 'denied' };
	}
	unlink(record_path(client));
	syslog(LOG_INFO, `accepted login for ${username} from ${client}`);
	let name = request.https ? 'sysauth_https' : 'sysauth_http';
	let flags = request.https ? '; secure' : '';
	return { cookie: `${name}=${session.ubus_rpc_session}; path=${COOKIE_PATH}; SameSite=strict; HttpOnly${flags}` };
}

export { login };
