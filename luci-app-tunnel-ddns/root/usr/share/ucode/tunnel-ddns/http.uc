// tunnel-ddns http: HTTP(S) requests through uclient-fetch (part of the stock image), so the
// package needs neither curl nor wget.
//
//   import { request, urlencode } from 'tunnel-ddns.http';
//
//   let r = request('GET', url, { headers: { Authorization: 'Bearer …' }, timeout: 20 });
//   r.ok      true for a 2xx answer
//   r.status  the HTTP status of an error answer (uclient-fetch passes no body then), or 0
//   r.body    the answer
//   r.error   why the request failed ('HTTP error 403', 'Connection failed', …)
//
// Methods: GET, POST, PUT, DELETE (uclient-fetch has no PATCH). A body is sent as given;
// set the Content-Type header for it.

'use strict';

import { popen, readfile, unlink, mkdir } from 'fs';

const RUN = '/tmp/tunnel-ddns';
let counter = 0;

function shq(s) {
	return "'" + replace(`${s ?? ''}`, "'", "'\\''") + "'";
}

function urlencode(s) {
	let out = '';
	s = `${s ?? ''}`;
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1), b = ord(s, i);
		if (match(c, /^[A-Za-z0-9._~-]$/)) out += c;
		else out += sprintf('%%%02X', b);
	}
	return out;
}

// a form body from an object: key=value&… with both parts encoded
function form(values) {
	return join('&', map(keys(values), k => `${urlencode(k)}=${urlencode(values[k])}`));
}

function request(method, url, opts) {
	opts ??= {};
	mkdir(RUN, 0o755);
	let err = sprintf('%s/http-%d-%d.err', RUN, time(), counter++);
	let cmd = sprintf('uclient-fetch -O - -T %d', opts.timeout ?? 20);
	if (opts.ipv4) cmd += ' -4';
	for (let k, v in opts.headers ?? {})
		cmd += ' --header=' + shq(`${k}: ${v}`);
	if (method == 'POST' && opts.body != null)
		cmd += ' --post-data=' + shq(opts.body);
	else if (method != 'GET') {
		cmd += ' --method=' + method;
		if (opts.body != null) cmd += ' --body-data=' + shq(opts.body);
	}
	cmd += ` ${shq(url)} 2>${shq(err)}`;
	let p = popen(cmd, 'r');
	let body = p ? (p.read('all') ?? '') : '';
	let code = p ? p.close() : -1;
	let msgs = split(trim(readfile(err) ?? ''), '\n');
	unlink(err);
	let last = trim(msgs[length(msgs) - 1] ?? '');
	let m = match(last, /HTTP error ([0-9]+)/);
	if (code == 0)
		return { ok: true, status: 200, body: body, error: '' };
	return { ok: false, status: m ? int(m[1]) : 0, body: body, error: last || `uclient-fetch exit code ${code}` };
}

// a JSON answer of a request, or null; r gets r.json
function request_json(method, url, opts) {
	let r = request(method, url, opts);
	try { r.json = json(r.body); } catch (e) { r.json = null; }
	return r;
}

export { urlencode, form, request, request_json };
