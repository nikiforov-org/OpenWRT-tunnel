#!/usr/bin/env ucode

'use strict';

import { access, popen, readfile, writefile, lsdir, stat, mkdir, unlink, readlink, open } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';
import { info } from 'xtunnel.x509';
import { grade, in_effect, target, move_state, note_watch, confirm } from 'xtunnel-ddns.sitecert';
import { request } from 'xtunnel-ddns.http';

const CFG       = 'xtunnel-ddns';
const SITES     = '/usr/share/www';            // document roots, one directory per site
const BACKENDS  = '/etc/xtunnel-ddns/sites';    // the sites' build scripts (the archive's .xtunnel-ddns/)
const CERTS     = '/etc/ssl/xtunnel-ddns';
const RUN       = '/tmp/xtunnel-ddns';
const STATE     = '/etc/xtunnel-ddns/state';     // result of the last site build, kept across reboots
const UPLOAD    = '/tmp/xtunnel-ddns-upload.tar.gz';
const LUCI_GATE = '/usr/libexec/xtunnel-ddns/luci-gate';
const SYNC      = '/usr/libexec/xtunnel-ddns/sync';
const CERT      = '/usr/libexec/xtunnel-ddns/cert';
const SITEBUILD = '/usr/libexec/xtunnel-ddns/sitebuild';
const UPDATE    = '/usr/libexec/xtunnel-ddns/update';
const MOVE      = '/usr/libexec/xtunnel-ddns/move';

function exec(command) {
	let p = popen(command, 'r');
	if (p == null)
		return { code: -1, out: '' };
	let out = p.read('all') ?? '';
	return { code: p.close(), out: out };
}

function shq(s) {
	if (s == null || s == '') return "''";
	return "'" + replace(`${s}`, "'", "'\\''") + "'";
}

function valid_sid(s) {
	return type(s) == 'string' && match(s, /^[A-Za-z0-9_]{1,64}$/) != null;
}

function valid_site(s) {
	return type(s) == 'string' && match(s, /^[a-z0-9][a-z0-9._-]{0,31}$/) != null;
}

function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, length(lines) - n);
	return join('\n', lines);
}

function cached(name, ttl, fn) {
	mkdir(RUN, 0o755);
	let path = `${RUN}/${name}`;
	let st = stat(path);
	if (st && st.size > 0 && (time() - st.mtime) < ttl)
		return readfile(path);
	let value = fn() ?? '';
	writefile(path, value);
	return value;
}

// the public address: written by update at each of its runs, looked up here when older than 2 minutes
function public_ip(url) {
	if (!url) return '';
	return cached('public_ip', 120, function() {
		let r = request('GET', url, { ipv4: true, timeout: 5 });
		let m = r.ok ? match(r.body, /([0-9]{1,3}(\.[0-9]{1,3}){3})/) : null;
		return m ? m[1] : '';
	});
}

function resolve(host) {
	if (!host) return '';
	return cached(`resolve-${host}`, 60, function() {
		let r = exec(`nslookup ${shq(host)} 2>/dev/null`);
		let out = [], seen = false;
		for (let l in split(r.out, '\n')) {
			if (index(l, 'Name:') >= 0) { seen = true; continue; }
			if (!seen) continue;
			let m = match(l, /Address[^:]*:[ \t]*([0-9.]+)/);
			if (m) push(out, m[1]);
		}
		return join(',', out);
	});
}

// the installed certificate: read once per change of the file (rpcd keeps this plugin loaded)
let cert_cache = {};
function cert_info(host) {
	let crt = `${CERTS}/${host}/fullchain.pem`;
	let st = host ? stat(crt) : null;
	if (!st)
		return null;
	let key = `${st.mtime}/${st.size}`, c = cert_cache[host];
	if (c?.key != key) {
		let i = info(readfile(crt));
		c = cert_cache[host] = { key: key, info: i };
	}
	let i = c.info;
	if (!i || !i.not_after)
		return { error: 'cannot read certificate' };
	return {
		cn: i.subject_cn ?? host,
		expires: i.not_after,
		valid: time() < i.not_after,
		staging: index(i.issuer_cn ?? '', 'STAGING') >= 0,
		// a test certificate issued while this trusted one is in use: kept apart (see cert)
		staging_apart: access(`${CERTS}/${host}/staging/fullchain.pem`) == true,
		path: crt
	};
}

function parse_state(path, timeout) {
	let s = trim(readfile(path) ?? '');
	if (!s) return null;
	let m = match(s, /^([a-z]+) ([0-9]+)( ([0-9]+))?( host=([^ ]+))?$/);
	if (!m) return null;
	let st = { state: m[1], ts: int(m[2]), host: m[6] };
	if (st.state == 'running' && m[4] && access(`/proc/${m[4]}`) != true)
		st = { state: 'failed', ts: st.ts, reason: 'The process ended unexpectedly.' };
	else if (st.state == 'starting' && (time() - st.ts) > timeout)
		st = { state: 'failed', ts: st.ts, reason: 'The process did not start.' };
	else if (st.state == 'starting')
		st.state = 'running';
	return st;
}

// the certificate job of a domain; a job for another hostname (the domain was edited since) does not count
function job_state(sid, host) {
	let st = parse_state(`${RUN}/cert-${sid}.state`, 120);
	return (host != null && st?.host && st.host != lc(host)) ? null : st;
}
function site_job_state(name) { return parse_state(`${STATE}/site-${name}.state`, 120); }

let ubus = null;
function svc_running(name) {
	ubus ??= connect();
	let inst = ubus?.call('service', 'list', { name: name })?.[name]?.instances;
	for (let k, v in inst ?? {}) if (v.running) return true;
	return false;
}

// ---- sites ----

function site_has_build(name) { return access(`${BACKENDS}/${name}/build`, 'x') == true; }
function site_has_login(name) { return access(`${SITES}/${name}/cgi-bin/login`) == true; }

function site_list() {
	let out = [];
	let sizes = {};
	let r = { out: cached('sizes', 60, () => exec(`du -sk ${SITES}/* 2>/dev/null`).out) };
	for (let l in split(r.out, '\n')) {
		let m = match(l, /^([0-9]+)[ \t]+(.+)$/);
		if (m) sizes[rtrim(m[2], '/')] = int(m[1]);
	}
	for (let name in sort(lsdir(SITES) ?? [])) {
		let dir = `${SITES}/${name}`;
		if (stat(dir)?.type != 'directory') continue;
		push(out, {
			name: name,
			builtin: (name == 'default'),
			has_index: access(`${dir}/index.html`) == true,
			has_build: site_has_build(name),
			has_login: site_has_login(name),
			size_kb: sizes[dir] ?? 0
		});
	}
	return out;
}

// starts a build of the site in the background; sitebuild reports through the state file
function start_build(name) {
	mkdir(RUN, 0o755);
	mkdir(STATE, 0o755);
	writefile(`${STATE}/site-${name}.state`, `starting ${time()}`);
	exec(`setsid ${SITEBUILD} ${shq(name)} >/dev/null 2>&1 </dev/null &`);
}

function overlay_free_kb(fresh) {
	let r = { out: fresh ? exec('df -k /overlay 2>/dev/null').out : cached('df', 60, () => exec('df -k /overlay 2>/dev/null').out) };
	let lines = split(rtrim(r.out, '\n'), '\n');
	let m = match(lines[length(lines) - 1] ?? '', /\s([0-9]+)\s+[0-9]+%/);
	return m ? int(m[1]) : null;
}

// the address updates of a domain: update keeps their state (see there)
function ddns_status(sid) {
	let s = null;
	try { s = json(readfile(`${RUN}/ddns-${sid}.json`) ?? ''); } catch (e) { s = null; }
	return { last_update: s?.sent ?? null, last_check: s?.checked ?? null, ip: s?.ip ?? '', error: s?.error ?? '' };
}

// a move of the site waits for an open page (see move): started from the page's status calls,
// at most every 20 seconds and only while no run is going
let move_kicked = 0;
function move_kick(mv, to) {
	if (!to || time() - move_kicked < 20) return;
	if (mv?.state == 'failed' && mv.to == to && time() - (mv.attempt ?? 0) < ((mv.kind == 'confirm') ? 600 : 3600)) return;
	let f = open(`${RUN}/move.lock`, 'r');
	let idle = !f || f.lock('xn');
	f?.close();
	if (!idle) return;
	move_kicked = time();
	exec(`setsid ${MOVE} >/dev/null 2>&1 </dev/null &`);
}

const methods = {};

methods.status = {
	args: { host: '' },
	call: function(req) {
		let uci = cursor();
		uci.load(CFG);
		uci.load('uhttpd');
		uci.load('firewall');
		let main = uci.get_all(CFG, 'main') ?? {};
		let ip_url = main.ip_url ?? '';
		let domains = {};
		let site = main.site ?? 'default';
		uci.foreach(CFG, 'domain', function(s) {
			let sid = s['.name'];
			let host = s.hostname ?? '';
			domains[sid] = {
				hostname: host,
				provider: s.provider ?? '',
				enabled: (s.enabled == '1'),
				staging: (s.staging == '1'),
				resolved: host ? resolve(host) : '',
				ddns: ddns_status(sid),
				cert: cert_info(host),
				job: job_state(sid, host)
			};
		});
		let home = uci.get('uhttpd', 'main', 'home') ?? '/www';
		let site_host = main.site_domain ? (uci.get(CFG, main.site_domain, 'hostname') ?? '') : '';
		let eff = in_effect(), g = eff ? grade(eff) : null;
		let crontab = readfile('/etc/crontabs/root') ?? '';
		// the page tells the address it is open under: a move waits for an open page, and a page
		// under the new name confirms that the browser reaches the router there
		let mv = move_state(), here = lc(req.args?.host ?? '');
		if (here) {
			note_watch(here);
			if (mv?.state == 'switched' && mv.to == here) confirm(here);
			let t = (main.site_enabled == '1') ? target(uci, CFG) : null;
			if (t && (t.host != eff || (g?.grade ?? 0) < (t.staging ? 1 : 2))) move_kick(mv, t.host);
		}
		return {
			public_ip: public_ip(ip_url),
			main: {
				site_enabled: (main.site_enabled == '1'),
				site: site,
				site_domain: main.site_domain ?? '',
				site_hostname: site_host,
				site_port: main.site_port ?? '443',
				site_schedule: main.site_schedule ?? '',
				site_scheduled: index(crontab, '# xtunnel-ddns-site') >= 0,
				site_has_build: site_has_build(site),
				site_build: site_job_state(site),
				site_has_login: site_has_login(site),
				login_replaced: (readlink(`${SITES}/${site}/cgi-bin/luci`) == LUCI_GATE),
				uhttpd_home: home,
				uhttpd_cert: uci.get('uhttpd', 'main', 'cert') ?? '',
				uhttpd_running: svc_running('uhttpd'),
				serving: (home == `${SITES}/${site}`),
				firewall_rule: (uci.get('firewall', 'xtunnel_ddns_https') == 'rule'),
				xray_front: (index(`${uci.get('uhttpd', 'main', 'listen_https') ?? ''}`, '127.0.0.1:4443') >= 0),
				behind_port: 4443,
				cron: index(crontab, '# xtunnel-ddns-cert') >= 0,
				overlay_free_kb: overlay_free_kb()
			},
			// the name whose certificate the web server presents, and the move of the site to the
			// name of its domain (see move)
			site_cert: eff ? { host: eff, grade: g.grade, expires: g.expires ?? null, staging: g.staging ?? false } : null,
			move: mv,
			sites: site_list(),
			domains: domains
		};
	}
};

// a page called the router under the name the site moved to (see move): the browser reaches it there
methods.move_confirm = {
	args: { host: '' },
	call: function(req) {
		let mv = move_state(), host = lc(req.args.host ?? '');
		if (mv?.state != 'switched' || !host || mv.to != host)
			return { ok: false };
		confirm(host);
		return { ok: true };
	}
};

methods.ddns_update = {
	args: { section: '' },
	call: function(req) {
		let sid = req.args.section;
		if (!valid_sid(sid)) return { error: 'Invalid section.' };
		let uci = cursor();
		uci.load(CFG);
		if (uci.get(CFG, sid, 'enabled') != '1' || !uci.get(CFG, sid, 'hostname') || !uci.get(CFG, sid, 'provider'))
			return { error: 'This domain is not active. Enable it and click Save & Apply first.' };
		exec(`setsid ${UPDATE} ${shq(sid)} force >/dev/null 2>&1 </dev/null &`);
		return { ok: true };
	}
};

methods.ddns_log = {
	args: { section: '' },
	call: function(req) {
		let sid = req.args.section;
		if (!valid_sid(sid)) return { error: 'Invalid section.' };
		return { log: tail(readfile(`${RUN}/ddns-${sid}.log`) ?? '', 200) };
	}
};

methods.cert_issue = {
	args: { section: '' },
	call: function(req) {
		let sid = req.args.section;
		if (!valid_sid(sid)) return { error: 'Invalid section.' };
		let uci = cursor();
		uci.load(CFG);
		if (uci.get(CFG, sid) != 'domain') return { error: 'Unknown domain. Click Save & Apply first.' };
		if (!uci.get(CFG, sid, 'hostname') || !uci.get(CFG, sid, 'provider'))
			return { error: 'Set the hostname and the provider first.' };
		let job = job_state(sid);
		if (job && job.state == 'running')
			return { ok: true, already: true };
		let r = exec(`${CERT} issue ${shq(sid)} 2>&1`);
		return { ok: (r.code == 0), log: r.out };
	}
};

methods.cert_log = {
	args: { section: '' },
	call: function(req) {
		let sid = req.args.section;
		if (!valid_sid(sid)) return { error: 'Invalid section.' };
		return { log: tail(readfile(`${RUN}/cert-${sid}.log`) ?? '', 300), job: job_state(sid) };
	}
};

methods.site_install = {
	args: { name: '', replace: false },
	call: function(req) {
		let name = req.args.name;
		if (!valid_site(name)) return { error: 'Site name may contain lowercase letters, digits, dots, dashes and underscores (max 32 characters).' };
		if (name == 'default') return { error: 'The name "default" is reserved for the built-in site.' };
		if (access(UPLOAD) != true) return { error: 'No archive has been uploaded.' };
		let st = stat(UPLOAD);
		let free = overlay_free_kb(true);
		if (free != null && free * 1024 < st.size * 3) {
			unlink(UPLOAD);
			return { error: `Not enough free space on the router (${free} KB free).` };
		}
		let listing = exec(`tar -tzf ${shq(UPLOAD)} 2>&1`);
		if (listing.code != 0) {
			unlink(UPLOAD);
			return { error: 'The file is not a .tar.gz archive: ' + trim(tail(listing.out, 1)) };
		}
		let entries = split(rtrim(listing.out, '\n'), '\n');
		let top = null, root_index = false, same_top = true;
		for (let e in entries) {
			if (e == '') continue;
			let n = replace(e, /^\.\//, '');
			if (n == '' || n == './') continue;
			if (substr(e, 0, 1) == '/' || match(n, /(^|\/)\.\.(\/|$)/)) {
				unlink(UPLOAD);
				return { error: `The archive contains an unsafe path: ${e}` };
			}
			if (n == 'index.html') root_index = true;
			let first = split(n, '/')[0];
			if (first == '.xtunnel-ddns') continue;
			if (top == null) top = first;
			else if (top != first) same_top = false;
		}
		let names = map(entries, e => replace(e, /^\.\//, ''));
		let subdir = '';
		if (!root_index) {
			if (same_top && top && (`${top}/index.html` in names))
				subdir = top;
			else {
				unlink(UPLOAD);
				return { error: 'index.html was not found at the top level of the archive.' };
			}
		}

		let root = `${SITES}/${name}`;
		let backend = `${BACKENDS}/${name}`;
		if (access(root) == true || access(backend) == true) {
			if (!req.args.replace)
				return { error: `A site named "${name}" already exists.`, exists: true };
		}

		let tmp = `${RUN}/extract-${time()}`;
		exec(`rm -rf ${shq(tmp)}; mkdir -p ${shq(tmp)}`);
		let x = exec(`tar -xzf ${shq(UPLOAD)} -C ${shq(tmp)} 2>&1`);
		if (x.code != 0) {
			exec(`rm -rf ${shq(tmp)}`); unlink(UPLOAD);
			return { error: 'Could not unpack the archive: ' + trim(tail(x.out, 1)) };
		}
		let src = subdir ? `${tmp}/${subdir}` : tmp;

		// the public files become the document root; .xtunnel-ddns/ (build script and what it
		// needs) is kept outside the web root
		exec(`rm -rf ${shq(root)} ${shq(backend)}`);
		if (access(`${src}/.xtunnel-ddns`) == true) {
			exec(`mkdir -p ${shq(BACKENDS)}`);
			exec(`mv ${shq(src + '/.xtunnel-ddns')} ${shq(backend)}`);
		}
		exec(`mv ${shq(src)} ${shq(root)}`);
		exec(`rm -rf ${shq(tmp)}`);
		unlink(UPLOAD);
		if (access(`${root}/index.html`) != true) {
			exec(`rm -rf ${shq(root)} ${shq(backend)}`);
			return { error: 'Unpacking failed: index.html is missing.' };
		}
		exec(`chown -R 0:0 ${shq(root)} ${shq(backend)} 2>/dev/null; chmod -R u=rwX,go=rX ${shq(root)} ${shq(backend)} 2>/dev/null`);
		exec(`chmod 755 ${shq(backend + '/build')} ${shq(root)}/cgi-bin/* 2>/dev/null`);

		unlink(`${RUN}/sizes`);
		// if this site is the one being served, its LuCI links are refreshed right away
		exec(`${SYNC} 2>&1`);
		if (site_has_build(name))
			start_build(name);
		return { ok: true, name: name, has_build: site_has_build(name), has_login: site_has_login(name) };
	}
};

methods.site_delete = {
	args: { name: '' },
	call: function(req) {
		let name = req.args.name;
		if (!valid_site(name)) return { error: 'Invalid site name.' };
		if (name == 'default') return { error: 'The built-in site cannot be deleted.' };
		if (access(`${SITES}/${name}`) != true && access(`${BACKENDS}/${name}`) != true)
			return { error: 'No such site.' };
		let uci = cursor();
		uci.load(CFG);
		let was_active = (uci.get(CFG, 'main', 'site') == name);
		if (was_active) {
			uci.set(CFG, 'main', 'site', 'default');
			uci.commit(CFG);
		}
		exec(`rm -rf ${shq(SITES + '/' + name)} ${shq(BACKENDS + '/' + name)}`);
		unlink(`${STATE}/site-${name}.state`);
		unlink(`${RUN}/sizes`);
		if (was_active)
			exec(`${SYNC} 2>&1`);
		return { ok: true, switched_to_default: was_active };
	}
};

methods.site_rebuild = {
	args: { name: '' },
	call: function(req) {
		let uci = cursor();
		uci.load(CFG);
		let name = req.args.name;
		if (!name || name == '') name = uci.get(CFG, 'main', 'site') ?? 'default';
		if (!valid_site(name)) return { error: 'Invalid site name.' };
		if (!site_has_build(name)) return { error: 'This site has no build script.' };
		let job = site_job_state(name);
		if (job && job.state == 'running') return { ok: true, already: true };
		start_build(name);
		return { ok: true };
	}
};

methods.site_rebuild_log = {
	args: { name: '' },
	call: function(req) {
		let uci = cursor();
		uci.load(CFG);
		let name = req.args.name;
		if (!name || name == '') name = uci.get(CFG, 'main', 'site') ?? 'default';
		if (!valid_site(name)) return { error: 'Invalid site name.' };
		return { log: tail(readfile(`${RUN}/site-${name}.log`) ?? '', 300), job: site_job_state(name) };
	}
};

methods.set_port = {
	args: { port: '' },
	call: function(req) {
		let p = `${req.args.port}`;
		if (!match(p, /^[0-9]{1,5}$/) || int(p) < 1 || int(p) > 65535)
			return { error: 'Port must be a number between 1 and 65535.' };
		let uci = cursor();
		uci.load(CFG);
		uci.set(CFG, 'main', 'site_port', p);
		uci.commit(CFG);
		// apply in the background so this reply returns before uhttpd restarts on the new port
		exec(`setsid ${SYNC} >/dev/null 2>&1 </dev/null &`);
		return { ok: true, port: p };
	}
};

methods.revert = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		uci.set(CFG, 'main', 'site_enabled', '0');
		uci.foreach(CFG, 'domain', function(s) {
			uci.set(CFG, s['.name'], 'enabled', '0');
		});
		uci.commit(CFG);
		let r = exec(`${SYNC} 2>&1`);
		return { ok: (r.code == 0), log: r.out };
	}
};

return { 'xtunnel-ddns': methods };
