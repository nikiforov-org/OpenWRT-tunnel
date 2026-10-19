'use strict';

import { access, popen, readfile } from 'fs';
import { cursor } from 'uci';

const CFG   = 'tunnel-zerotier';
const ERROR = '/tmp/tunnel-zerotier/error';
const CLI   = '/usr/bin/zerotier-cli';
const INIT  = '/etc/init.d/tunnel-zerotier';
const API   = 'https://api.zerotier.com/api/v1';
const ZONE  = 'tunnel_zerotier';

function exec(command) {
	let p = popen(command, 'r');
	if (p == null)
		return { code: -1, out: '' };
	let out = p.read('all') ?? '';
	return { code: p.close(), out: out };
}

function shq(s) {
	return "'" + replace(`${s ?? ''}`, "'", "'\\''") + "'";
}

function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, length(lines) - n);
	return join('\n', lines);
}

function valid_nwid(s) {
	return type(s) == 'string' && match(s, /^[0-9a-f]{16}$/) != null;
}

function valid_node(s) {
	return type(s) == 'string' && match(s, /^[0-9a-f]{10}$/) != null;
}

function token() {
	let uci = cursor();
	uci.load(CFG);
	return trim(uci.get(CFG, 'main', 'api_token') ?? '');
}

// ZeroTier Central API through curl; returns { http, data, raw }
function api(method, path, body) {
	let tk = token();
	if (tk == '')
		return { http: 0, data: null, raw: 'no API token set' };
	let cmd = `curl -s -m 25 -w ${shq('\n%{http_code}')} -X ${method} -H ${shq('Authorization: Bearer ' + tk)} -H 'Content-Type: application/json'`;
	if (body != null)
		cmd += ` -d ${shq(body)}`;
	cmd += ` ${shq(API + path)}`;
	let r = exec(cmd);
	let lines = split(rtrim(r.out, '\n'), '\n');
	let http = int(lines[length(lines) - 1] ?? '0');
	let text = join('\n', slice(lines, 0, length(lines) - 1));
	let data = null;
	try { data = json(text); } catch (e) { data = null; }
	return { http: http, data: data, raw: text };
}

function api_error(r) {
	if (r.http == 0) return r.raw;
	if (r.http == 401 || r.http == 403) return `Central answered ${r.http}: the API token is wrong or expired`;
	return `Central answered ${r.http}: ${substr(trim(r.raw), 0, 200)}`;
}

function node_info() {
	let out = { node_id: '', online: false, version: '' };
	if (access(CLI, 'x') != true) return out;
	let j; try { j = json(exec(`${CLI} -j info 2>/dev/null`).out); } catch (e) { j = null; }
	if (j) { out.node_id = j.address ?? ''; out.online = (j.online == true); out.version = j.version ?? ''; }
	return out;
}

function joined_networks() {
	let out = {};
	if (access(CLI, 'x') != true) return out;
	let arr; try { arr = json(exec(`${CLI} -j listnetworks 2>/dev/null`).out); } catch (e) { arr = null; }
	for (let n in (type(arr) == 'array' ? arr : [])) {
		let ip = (type(n.assignedAddresses) == 'array' && length(n.assignedAddresses)) ? split(n.assignedAddresses[0], '/')[0] : '';
		out[n.id] = { id: n.id, name: n.name ?? '', status: n.status ?? '', ip: ip, iface: n.portDeviceName ?? '' };
	}
	return out;
}

function hostname() {
	return trim(readfile('/proc/sys/kernel/hostname') ?? '') || 'router';
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		uci.load('firewall');
		let main = uci.get_all(CFG, 'main') ?? {};
		let info = node_info();
		let joined = joined_networks();
		let networks = [];
		uci.foreach(CFG, 'network', function(s) {
			let j = joined[s.id] ?? null;
			push(networks, { sid: s['.name'], id: s.id ?? '', name: s.name ?? '', enabled: (s.enabled != '0'),
				joined: (j != null), status: j?.status ?? '', ip: j?.ip ?? '', iface: j?.iface ?? '', central_name: j?.name ?? '' });
		});
		return {
			installed: (access(CLI, 'x') == true),
			running: (exec('pidof zerotier-one >/dev/null 2>&1').code == 0),
			enabled: (main.enabled == '1'),
			local_access: (main.local_access != '0'),
			has_token: (trim(main.api_token ?? '') != ''),
			node_id: info.node_id,
			online: info.online,
			version: info.version,
			networks: networks,
			zone: (uci.get('firewall', ZONE) == 'zone'),
			error: trim(readfile(ERROR) ?? '')
		};
	}
};

methods.central_networks = {
	call: function() {
		let r = api('GET', '/network');
		if (r.http != 200 || type(r.data) != 'array')
			return { error: api_error(r) };
		let out = [];
		for (let n in r.data) {
			let c = n.config ?? {};
			push(out, { id: n.id, name: c.name ?? '', members: n.totalMemberCount ?? 0, online: n.onlineMemberCount ?? 0,
				routes: map(c.routes ?? [], rt => rt.target + (rt.via ? ' via ' + rt.via : '')) });
		}
		return { networks: out };
	}
};

methods.members = {
	args: { nwid: '' },
	call: function(req) {
		if (!valid_nwid(req.args.nwid)) return { error: 'Invalid network ID.' };
		let r = api('GET', `/network/${req.args.nwid}/member`);
		if (r.http != 200 || type(r.data) != 'array')
			return { error: api_error(r) };
		let out = [];
		for (let m in r.data) {
			let c = m.config ?? {};
			push(out, { node_id: m.nodeId, name: m.name ?? '', authorized: (c.authorized == true),
				ip: (type(c.ipAssignments) == 'array' && length(c.ipAssignments)) ? c.ipAssignments[0] : '',
				last_seen: m.lastSeen ?? 0, online: (m.online == true) });
		}
		return { members: out };
	}
};

methods.set_member = {
	args: { nwid: '', node_id: '', authorized: '', ip: '', name: '' },
	call: function(req) {
		let a = req.args;
		if (!valid_nwid(a.nwid) || !valid_node(a.node_id)) return { error: 'Invalid network or node ID.' };
		let cfg = { authorized: (a.authorized == '1' || a.authorized == true) };
		if (a.ip != null && a.ip != '') {
			if (!match(a.ip, /^[0-9.]+$/)) return { error: `Invalid IP address "${a.ip}".` };
			cfg.ipAssignments = [ a.ip ];
		}
		let payload = { config: cfg };
		if (a.name != null) payload.name = a.name;
		let r = api('POST', `/network/${a.nwid}/member/${a.node_id}`, sprintf('%J', payload));
		if (r.http != 200) return { error: api_error(r) };
		return { ok: true };
	}
};

methods.del_member = {
	args: { nwid: '', node_id: '' },
	call: function(req) {
		let a = req.args;
		if (!valid_nwid(a.nwid) || !valid_node(a.node_id)) return { error: 'Invalid network or node ID.' };
		let r = api('DELETE', `/network/${a.nwid}/member/${a.node_id}`);
		if (r.http != 200) return { error: api_error(r) };
		return { ok: true };
	}
};

methods.routes = {
	args: { nwid: '' },
	call: function(req) {
		if (!valid_nwid(req.args.nwid)) return { error: 'Invalid network ID.' };
		let r = api('GET', `/network/${req.args.nwid}`);
		if (r.http != 200 || type(r.data) != 'object')
			return { error: api_error(r) };
		let c = r.data.config ?? {};
		return { name: c.name ?? '', routes: map(c.routes ?? [], rt => ({ target: rt.target, via: rt.via ?? '' })) };
	}
};

methods.set_routes = {
	args: { nwid: '', routes: [] },
	call: function(req) {
		let a = req.args;
		if (!valid_nwid(a.nwid)) return { error: 'Invalid network ID.' };
		let routes = [];
		for (let rt in (type(a.routes) == 'array' ? a.routes : [])) {
			if (!match(rt.target ?? '', /^[0-9a-fA-F.:]+\/[0-9]+$/)) return { error: `Invalid route target "${rt.target}".` };
			let o = { target: rt.target };
			if (rt.via) {
				if (!match(rt.via, /^[0-9a-fA-F.:]+$/)) return { error: `Invalid gateway "${rt.via}".` };
				o.via = rt.via;
			}
			push(routes, o);
		}
		let r = api('POST', `/network/${a.nwid}`, sprintf('%J', { config: { routes: routes } }));
		if (r.http != 200) return { error: api_error(r) };
		return { ok: true };
	}
};

methods.create_network = {
	args: { name: '' },
	call: function(req) {
		let name = trim(req.args.name ?? '');
		if (name == '') return { error: 'Enter a name for the network.' };
		let r = api('POST', '/network', sprintf('%J', { config: { name: name, private: true } }));
		if (r.http != 200) return { error: api_error(r) };
		return { ok: true, id: r.data?.id ?? '' };
	}
};

methods.del_network = {
	args: { nwid: '' },
	call: function(req) {
		if (!valid_nwid(req.args.nwid)) return { error: 'Invalid network ID.' };
		let r = api('DELETE', `/network/${req.args.nwid}`);
		if (r.http != 200) return { error: api_error(r) };
		return { ok: true };
	}
};

// authorize this router's node in a network of the account (all configured networks when nwid is empty)
methods.authorize_self = {
	args: { nwid: '' },
	call: function(req) {
		let info = node_info();
		if (!info.node_id) return { error: 'The ZeroTier service is not running, so the node ID is not known yet.' };
		let ids = [];
		if (req.args.nwid) {
			if (!valid_nwid(req.args.nwid)) return { error: 'Invalid network ID.' };
			ids = [ req.args.nwid ];
		}
		else {
			let uci = cursor();
			uci.load(CFG);
			uci.foreach(CFG, 'network', function(s) { if (s.enabled != '0' && valid_nwid(s.id)) push(ids, s.id); });
		}
		let done = [];
		for (let id in ids) {
			let r = api('POST', `/network/${id}/member/${info.node_id}`, sprintf('%J', { name: hostname(), config: { authorized: true } }));
			if (r.http != 200) return { error: `${id}: ${api_error(r)}` };
			push(done, id);
		}
		return { ok: true, node_id: info.node_id, networks: done };
	}
};

methods.log = {
	call: function() {
		return { log: tail(exec(`logread 2>/dev/null | grep -E 'tunnel-zerotier|zerotier'`).out, 200) };
	}
};

methods.restart = {
	call: function() {
		let r = exec('/etc/init.d/zerotier restart 2>&1');
		return { ok: (r.code == 0), log: r.out };
	}
};

return { 'tunnel-zerotier': methods };
