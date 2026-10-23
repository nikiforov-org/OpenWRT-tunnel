// xtunnel-ddns providers: the DNS providers of the Dynamic DNS page.
//
//   import { provider } from 'xtunnel-ddns.providers';
//
//   let p = provider(section);          // section = the uci values of a domain, or null if unknown
//   p.update(host, ip)                  // the A record of host → ip: { ok, message }
//   p.txt_add(fqdn, value)              // a TXT record for DNS-01: { ok, message }
//   p.txt_remove(fqdn, value)           // that TXT record removed: { ok, message }
//
// Every call is a few HTTPS requests through uclient-fetch (xtunnel-ddns.http). The address
// updates follow the service definitions of ddns-scripts, the TXT records the DNS APIs of the
// providers as acme.sh's dnsapi scripts use them.

'use strict';

import { request, request_json, urlencode, form } from 'xtunnel-ddns.http';

function fail(message) { return { ok: false, message: message }; }
function done(message) { return { ok: true, message: message ?? 'OK' }; }

// "answer not understood" with the start of the answer, for the log
function answer(r) {
	if (!r.ok) return r.error;
	let b = trim(r.body);
	return length(b) > 160 ? substr(b, 0, 160) + '…' : (b || 'empty answer');
}

// the labels of a name from the longest suffix to the shortest: a.b.c → [ a.b.c, b.c, c ]
function suffixes(name) {
	let parts = split(name, '.'), out = [];
	for (let i = 0; i < length(parts) - 1; i++)
		push(out, join('.', slice(parts, i)));
	return out;
}

// ---- DuckDNS: one TXT record per domain, shared by its subdomains ----

function duckdns(s) {
	let token = s.duckdns_token ?? '';
	let sub = (host) => replace(lc(host), /^(_acme-challenge\.)?(.*\.)?([a-z0-9-]+)\.duckdns\.org$/, '$3');
	let call = (q) => request('GET', 'https://www.duckdns.org/update?' + q);
	return {
		update: function(host, ip) {
			let r = call(`domains=${urlencode(sub(host))}&token=${urlencode(token)}&ip=${urlencode(ip)}`);
			return (r.ok && trim(r.body) == 'OK') ? done() : fail(answer(r));
		},
		txt_add: function(fqdn, value) {
			let r = call(`domains=${urlencode(sub(fqdn))}&token=${urlencode(token)}&txt=${urlencode(value)}`);
			return (r.ok && trim(r.body) == 'OK') ? done() : fail(answer(r));
		},
		txt_remove: function(fqdn, value) {
			let r = call(`domains=${urlencode(sub(fqdn))}&token=${urlencode(token)}&txt=&clear=true`);
			return (r.ok && trim(r.body) == 'OK') ? done() : fail(answer(r));
		}
	};
}

// ---- dynv6: update API with the zone token, REST API v2 with the HTTP token ----

function dynv6(s) {
	let token = s.dynv6_token ?? '';
	const API = 'https://dynv6.com/api/v2';
	let hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	// the zone of the account the name belongs to (the longest matching zone name)
	let zone = function(fqdn) {
		let r = request_json('GET', `${API}/zones`, { headers: hdr });
		if (!r.ok || type(r.json) != 'array') return { error: answer(r) };
		let best = null;
		for (let z in r.json)
			if (type(z?.name) == 'string' && (fqdn == z.name || substr(fqdn, -length(z.name) - 1) == '.' + z.name))
				if (!best || length(z.name) > length(best.name)) best = z;
		return best ?? { error: `no zone of this account contains ${fqdn}` };
	};
	let rel = (fqdn, z) => (fqdn == z.name) ? '' : substr(fqdn, 0, length(fqdn) - length(z.name) - 1);
	return {
		update: function(host, ip) {
			let r = request('GET', `https://dynv6.com/api/update?hostname=${urlencode(host)}&token=${urlencode(token)}&ipv4=${urlencode(ip)}`);
			return (r.ok && match(r.body, /updated|unchanged/)) ? done(trim(r.body)) : fail(answer(r));
		},
		txt_add: function(fqdn, value) {
			let z = zone(fqdn);
			if (z.error) return fail(z.error);
			let r = request('POST', `${API}/zones/${z.id}/records`, { headers: hdr,
				body: sprintf('%J', { name: rel(fqdn, z), data: value, type: 'TXT' }) });
			return (r.ok && index(r.body, value) >= 0) ? done() : fail(answer(r));
		},
		txt_remove: function(fqdn, value) {
			let z = zone(fqdn);
			if (z.error) return fail(z.error);
			let r = request_json('GET', `${API}/zones/${z.id}/records`, { headers: hdr });
			if (!r.ok || type(r.json) != 'array') return fail(answer(r));
			let name = rel(fqdn, z), gone = 0;
			for (let rec in r.json) {
				if (rec?.type != 'TXT' || rec?.name != name || rec?.data != value) continue;
				let d = request('DELETE', `${API}/zones/${z.id}/records/${rec.id}`, { headers: hdr });
				if (!d.ok) return fail(answer(d));
				gone++;
			}
			return done(`${gone} record(s) removed`);
		}
	};
}

// ---- IPv64: update API with the DynDNS key, the account API with the API key ----

function ipv64(s) {
	const API = 'https://ipv64.net/api';
	let hdr = { Authorization: `Bearer ${s.ipv64_api_key ?? ''}`, 'Content-Type': 'application/x-www-form-urlencoded' };
	// the account's domain the name belongs to: its name is a key of the get_domains answer
	let root = function(fqdn) {
		let r = request('GET', `${API}?get_domains`, { headers: hdr });
		if (!r.ok) return { error: answer(r) };
		let body = replace(r.body, /[ \t\n]/g, '');
		for (let d in suffixes(fqdn))
			if (index(body, `"${d}":`) >= 0) return { domain: d, prefix: (d == fqdn) ? '' : substr(fqdn, 0, length(fqdn) - length(d) - 1) };
		return { error: `no domain of this account contains ${fqdn}` };
	};
	let api = function(method, values) {
		let r = request(method, API, { headers: hdr, body: form(values) });
		if (r.status == 429) { system('sleep 10'); r = request(method, API, { headers: hdr, body: form(values) }); }
		return (r.ok && index(replace(r.body, /[ \t\n]/g, ''), '"info":"success"') >= 0) ? done() : fail(answer(r));
	};
	return {
		update: function(host, ip) {
			let r = request('GET', `https://ipv64.net/nic/update?domain=${urlencode(host)}&key=${urlencode(s.ipv64_ddns_key ?? '')}&ip=${urlencode(ip)}`);
			return (r.ok && match(r.body, /good|nochg/)) ? done(trim(r.body)) : fail(answer(r));
		},
		txt_add: function(fqdn, value) {
			let d = root(fqdn);
			if (d.error) return fail(d.error);
			return api('POST', { add_record: d.domain, praefix: d.prefix, type: 'TXT', content: value });
		},
		txt_remove: function(fqdn, value) {
			let d = root(fqdn);
			if (d.error) return fail(d.error);
			return api('DELETE', { del_record: d.domain, praefix: d.prefix, type: 'TXT', content: value });
		}
	};
}

// ---- DNSExit: RemoteUpdate with login and password, the JSON DNS API with the API key ----

function dnsexit(s) {
	let user = s.dnsexit_user ?? '', pass = s.dnsexit_password ?? '';
	let root = function(fqdn) {
		for (let d in suffixes(fqdn)) {
			let r = request('GET', `https://update.dnsexit.com/ipupdate/hosts.jsp?login=${urlencode(user)}&password=${urlencode(pass)}&domain=${urlencode(d)}`);
			if (r.ok && index(r.body, `0=${d}`) >= 0)
				return { domain: d, name: (d == fqdn) ? '' : substr(fqdn, 0, length(fqdn) - length(d) - 1) };
		}
		return { error: `no domain of this account contains ${fqdn}` };
	};
	let api = function(body) {
		let r = request('POST', 'https://api.dnsexit.com/dns/', { headers: { apikey: s.dnsexit_api_key ?? '', 'Content-Type': 'application/json' }, body: sprintf('%J', body) });
		return r.ok ? done(answer(r)) : fail(answer(r));
	};
	return {
		update: function(host, ip) {
			let r = request('GET', `https://update.dnsexit.com/RemoteUpdate.sv?login=${urlencode(user)}&password=${urlencode(pass)}&host=${urlencode(host)}&myip=${urlencode(ip)}`);
			return r.ok ? done(answer(r)) : fail(answer(r));
		},
		txt_add: function(fqdn, value) {
			let d = root(fqdn);
			if (d.error) return fail(d.error);
			return api({ domain: d.domain, add: { type: 'TXT', name: d.name, content: value, ttl: 0, overwrite: false } });
		},
		txt_remove: function(fqdn, value) {
			let d = root(fqdn);
			if (d.error) return fail(d.error);
			return api({ domain: d.domain, delete: { type: 'TXT', name: d.name, content: value } });
		}
	};
}

// ---- MyDNS.JP: directip with the master ID, directedit for the TXT record ----

function mydnsjp(s) {
	let id = s.mydnsjp_master_id ?? '', pw = s.mydnsjp_password ?? '';
	// the account's domain, from its member page
	let root = function(fqdn) {
		let r = request('POST', 'https://www.mydns.jp/members/', { body: form({ MENU: '100', masterid: id, masterpwd: pw }) });
		let m = match(r.body, /DNSINFO\[domainname\][^>]*value="([^"]*)"/);
		if (!r.ok || !m) return { error: 'the account\'s domain was not found (check the master ID and password)' };
		let d = lc(m[1]);
		return (fqdn == d || substr(fqdn, -length(d) - 1) == '.' + d) ? { domain: d } : { error: `${fqdn} is not in the account's domain ${d}` };
	};
	let edit = function(cmd, fqdn, value) {
		let d = root(fqdn);
		if (d.error) return fail(d.error);
		let r = request('POST', 'https://www.mydns.jp/directedit.html', {
			headers: { Authorization: 'Basic ' + b64enc(`${id}:${pw}`), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form({ CERTBOT_DOMAIN: d.domain, CERTBOT_VALIDATION: value, EDIT_CMD: cmd }) });
		return (r.ok && index(r.body, 'OK.') >= 0) ? done() : fail(answer(r));
	};
	return {
		update: function(host, ip) {
			let r = request('GET', `https://www.mydns.jp/directip.html?MID=${urlencode(id)}&PWD=${urlencode(pw)}&IPV4ADDR=${urlencode(ip)}`);
			return r.ok ? done(answer(r)) : fail(answer(r));
		},
		txt_add: (fqdn, value) => edit('REGIST', fqdn, value),
		txt_remove: (fqdn, value) => edit('DELETE', fqdn, value)
	};
}

// ---- Beget: dns/changeRecords replaces all user records of a name ----

function beget(s) {
	let change = function(fqdn, records) {
		let r = request_json('POST', 'https://api.beget.com/api/dns/changeRecords', {
			body: form({ login: s.beget_login ?? '', passwd: s.beget_api_password ?? '', input_format: 'json', output_format: 'json',
				input_data: sprintf('%J', { fqdn: fqdn, records: records }) }) });
		if (r.json?.status == 'success' && r.json?.answer?.status == 'success' && r.json?.answer?.result == true)
			return done();
		let e = r.json?.error_text ?? r.json?.answer?.errors?.[0]?.error_text;
		return fail(e ? `Beget: ${e}` : answer(r));
	};
	return {
		update: (host, ip) => change(host, { A: [ { value: ip } ] }),
		txt_add: (fqdn, value) => change(fqdn, { TXT: [ { priority: 10, value: value } ] }),
		txt_remove: (fqdn, value) => change(fqdn, {})
	};
}

// ---- Cloudflare: API token; the zone given by its ID or found from the name's parents ----

function cloudflare(s) {
	const API = 'https://api.cloudflare.com/client/v4';
	let hdr = { Authorization: `Bearer ${s.cf_token ?? ''}`, 'Content-Type': 'application/json' };
	let get = (path) => request_json('GET', API + path, { headers: hdr });
	let zone = function(fqdn) {
		if (length(s.cf_zone_id)) {
			let r = get(`/zones/${urlencode(s.cf_zone_id)}`);
			return (r.json?.success == true) ? { id: s.cf_zone_id } : { error: `zone ID not accepted: ${answer(r)}` };
		}
		for (let d in suffixes(fqdn)) {
			let r = get(`/zones?name=${urlencode(d)}`);
			if (!r.ok) return { error: answer(r) };
			if (type(r.json?.result) == 'array' && length(r.json.result)) return { id: r.json.result[0].id };
		}
		return { error: `no zone of this token contains ${fqdn}` };
	};
	return {
		update: function(host, ip) {
			let z = zone(host);
			if (z.error) return fail(z.error);
			let r = get(`/zones/${z.id}/dns_records?type=A&name=${urlencode(host)}`);
			let rec = r.json?.result?.[0];
			if (!r.ok || !rec) return fail(r.ok ? `there is no A record for ${host} to update` : answer(r));
			if (rec.content == ip) return done('already up to date');
			let u = request_json('PUT', `${API}/zones/${z.id}/dns_records/${rec.id}`, { headers: hdr,
				body: sprintf('%J', { type: 'A', name: host, content: ip, ttl: rec.ttl ?? 1, proxied: rec.proxied ?? false }) });
			return (u.json?.success == true) ? done() : fail(answer(u));
		},
		txt_add: function(fqdn, value) {
			let z = zone(fqdn);
			if (z.error) return fail(z.error);
			let r = request_json('POST', `${API}/zones/${z.id}/dns_records`, { headers: hdr,
				body: sprintf('%J', { type: 'TXT', name: fqdn, content: value, ttl: 120 }) });
			return (r.json?.success == true) ? done() : fail(answer(r));
		},
		txt_remove: function(fqdn, value) {
			let z = zone(fqdn);
			if (z.error) return fail(z.error);
			let r = get(`/zones/${z.id}/dns_records?type=TXT&name=${urlencode(fqdn)}&content=${urlencode(value)}`);
			if (!r.ok) return fail(answer(r));
			for (let rec in r.json?.result ?? []) {
				let d = request_json('DELETE', `${API}/zones/${z.id}/dns_records/${rec.id}`, { headers: hdr });
				if (d.json?.success != true) return fail(answer(d));
			}
			return done();
		}
	};
}

const MAKERS = { duckdns, dynv6, ipv64, dnsexit, mydnsjp, beget, cloudflare };

function provider(section) {
	let make = MAKERS[section?.provider ?? ''];
	return make ? make(section) : null;
}

export { provider };
