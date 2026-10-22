// tunnel-ddns dns: name lookups with busybox nslookup, for update, move and dns01.
//
//   import { lookup, name_servers, published } from 'tunnel-ddns.dns';
//
//   lookup(host, server)  the IPv4 addresses of a name, from SERVER or the router's resolver;
//                         null when the server did not answer
//   name_servers(host)    { zone, ns } of the name or of its nearest parent with NS records, or null
//   published(host)       the addresses at each of the zone's name servers that answers queries
//                         from here, one list each; [] when none does (after two that do not, the
//                         others are not asked: each costs nslookup's 5 seconds)
// A query to the zone's name servers leaves nothing in the router's resolver: a lookup through it
// of a name without a record yet keeps the negative answer there up to the zone's negative TTL.

'use strict';

import { popen } from 'fs';

function shq(s) { return "'" + replace(`${s ?? ''}`, "'", "'\\''") + "'"; }

function exec(cmd) {
	let p = popen(cmd, 'r');
	if (!p) return '';
	let out = p.read('all') ?? '';
	p.close();
	return out;
}

function lookup(host, server) {
	let out = exec(`nslookup ${shq(host)}${server ? ' ' + shq(server) : ''} 2>&1`), addrs = [], seen = false;
	if (index(out, 'no servers could be reached') >= 0 || index(out, 'timed out') >= 0) return null;
	for (let l in split(out, '\n')) {
		if (index(l, 'Name:') >= 0) { seen = true; continue; }
		let m = seen ? match(l, /Address[^:]*:[ \t]*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/) : null;
		if (m && !(m[1] in addrs)) push(addrs, m[1]);
	}
	return addrs;
}

function name_servers(host) {
	let parts = split(lc(host ?? ''), '.');
	for (let i = 0; i < length(parts) - 1; i++) {
		let zone = join('.', slice(parts, i)), ns = [];
		for (let l in split(exec(`nslookup -type=ns ${shq(zone)} 2>/dev/null`), '\n')) {
			let m = match(l, /nameserver = ([^ \t]+)/);
			if (m) push(ns, rtrim(m[1], '.'));
		}
		if (length(ns)) return { zone: zone, ns: ns };
	}
	return null;
}

function published(host) {
	let z = name_servers(host), lists = [], silent = 0;
	for (let s in z?.ns ?? []) {
		let a = lookup(host, s);
		if (a != null) push(lists, a);
		else if (++silent >= 2 && !length(lists)) break;
	}
	return lists;
}

export { lookup, name_servers, published };
