'use strict';

import { access, readfile, writefile, mkdir, unlink, chmod, stat, lsdir } from 'fs';
import { cursor } from 'uci';
import { RUN, CONF, exec, shq, base32, valid_key, public_key, tor_instance, bootstrap_phase } from 'tunnel-tor.common';

const CFG     = 'tunnel-tor';
const DIR     = '/etc/tunnel-tor';
const HS      = '/etc/tor/tunnel-tor';
const CLIENTS = `${HS}/authorized_clients`;
const ERROR   = `${RUN}/error`;
const TOR     = '/usr/sbin/tor';
const INIT    = '/etc/init.d/tunnel-tor';
const SHIPPED = '/usr/share/tunnel-tor/bridges.txt';
const LIST    = `${DIR}/bridges.txt`;
const BSTATE  = `${DIR}/bridges.state`;
const BRUN    = `${RUN}/bridges.running`;
const UPDATE  = '/usr/libexec/tunnel-tor/bridges-update';

function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, length(lines) - n);
	return join('\n', lines);
}

function valid_sid(s) {
	return type(s) == 'string' && match(s, /^[A-Za-z0-9_]{1,64}$/) != null;
}

// the port of the server's TCP + Vision transport (luci-app-tunnel-server) when it runs and is
// among the onion service's ports, else ''
function xray_port(ports) {
	let uci = cursor();
	if (!uci.load('tunnel-server') || uci.get('tunnel-server', 'main', 'enabled') != '1'
	    || uci.get('tunnel-server', 'main', 'vision_enabled') != '1') return '';
	for (let p in ports)
		if (`${p}` == `${uci.get('tunnel-server', 'main', 'vision_port') ?? '443'}`) return `${p}`;
	return '';
}

function onion() {
	return trim(readfile(`${HS}/hostname`) ?? '');
}

// tor's bootstrap: asked on its control port (the log lines are gone once the log buffer wrapped),
// kept once done for that process (rpcd keeps this plugin loaded); in the first seconds of a start,
// before the control port is there, the last log line of that process
let boot = { pid: null, value: null };
function bootstrap(inst) {
	if (boot.pid == inst.pid && boot.value?.percent == 100) return boot.value;
	let v = bootstrap_phase();
	if (v == null) {
		let m = match(exec(`logread 2>/dev/null | grep -E 'Tor\\[${inst.pid}\\]: Bootstrapped [0-9]+%' | tail -1`).out,
		              /Bootstrapped ([0-9]+)% \(([a-z_]+)\): ?(.*)$/);
		v = m ? { percent: int(m[1]), text: (m[2] == 'done') ? '' : trim(m[3]) } : null;
	}
	if (v) boot = { pid: inst.pid, value: v };
	return v;
}

// the tor version, read again only when the binary changed
let version = { key: null, value: '' };
function tor_version() {
	let st = stat(TOR), key = st ? `${st.mtime}/${st.size}` : null;
	if (key != version.key) {
		let m = key ? match(exec(`${TOR} --version 2>/dev/null`).out, /Tor version ([0-9]+(\.[0-9]+)*)/) : null;
		version = { key: key, value: m ? m[1] : '' };
	}
	return version.value;
}

// the snowflake bridges: the mode, how many snowflake and other lines the configured list has,
// whether snowflake is in the configuration in effect, what the watch script last saw
function snowflake_info(main) {
	let lines = [];
	if ((main.bridges ?? 'builtin') == 'builtin') {
		let text = readfile(LIST);
		if (text == null || !length(trim(text))) text = readfile(SHIPPED) ?? '';
		lines = split(text, '\n');
	}
	else if (main.bridges == 'custom')
		lines = (type(main.bridge) == 'array') ? main.bridge : (main.bridge ? [ main.bridge ] : []);
	let listed = 0, others = 0;
	for (let l in lines) {
		l = trim(replace(trim(l), /^Bridge +/, ''));
		if (!length(l)) continue;
		if (index(l, 'snowflake ') == 0) listed++; else others++;
	}
	let w = null;
	try { w = json(readfile(`${RUN}/watch.json`) ?? ''); } catch (e) { w = null; }
	let since = int(trim(readfile(`${DIR}/snowflake.on`) ?? ''));
	return {
		mode: main.snowflake ?? 'fallback',
		listed: listed,
		others: others,
		in_use: (index(readfile(CONF) ?? '', '\nBridge snowflake ') >= 0),
		fallback_since: (since > 0) ? since : null,
		watch: (type(w) == 'object') ? w : null
	};
}

// the bridge list in effect for the built-in mode: where it comes from and what it holds
function bridges_info(main) {
	let text = readfile(LIST), source = 'updated';
	if (text == null || !length(trim(text))) { text = readfile(SHIPPED) ?? ''; source = 'shipped'; }
	let by = {}, n = 0;
	for (let l in split(text, '\n')) {
		l = trim(replace(trim(l), /^Bridge +/, ''));
		if (!length(l)) continue;
		let t = split(l, ' ')[0];
		t = (index(t, ':') >= 0) ? 'vanilla' : t;
		by[t] = (by[t] ?? 0) + 1;
		n++;
	}
	let state = null;
	try { state = json(readfile(BSTATE) ?? ''); } catch (e) { state = null; }
	let r = stat(BRUN);
	return {
		mode: main.bridges ?? 'builtin',
		country: lc(trim(main.bridge_country ?? '')),
		source: source, lines: n, by: by,
		state: (type(state) == 'object') ? state : null,
		running: (r != null && time() - r.mtime < 600)
	};
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		let main = uci.get_all(CFG, 'main') ?? {};
		let enabled = (main.enabled == '1');
		let inst = tor_instance();
		let running = (inst != null);
		let profiles = [];
		uci.foreach(CFG, 'profile', function(s) {
			let name = trim(s.name ?? '');
			push(profiles, { sid: s['.name'], name: name, enabled: (s.enabled != '0'),
				authorized: (name != '' && access(`${CLIENTS}/${name}.auth`) == true) });
		});
		let st = stat(CONF);
		let bs = running ? bootstrap(inst) : null;
		return {
			installed: (access(TOR, 'x') == true),
			version: tor_version(),
			enabled: enabled,
			running: running,
			bootstrap: bs ? bs.percent : (running ? 0 : null),
			bootstrap_text: bs ? bs.text : '',
			onion: onion(),
			ports: (type(main.port) == 'array') ? main.port : (main.port ? [ main.port ] : []),
			bridges: main.bridges ?? 'builtin',
			bridges_info: bridges_info(main),
			snowflake: snowflake_info(main),
			profiles: profiles,
			config_time: st ? st.mtime : null,
			error: trim(readfile(ERROR) ?? ''),
			log_last: (enabled && !running) ? tail(exec(`logread 2>/dev/null | grep -E 'tunnel-tor|Tor\\['`).out, 3) : ''
		};
	}
};

methods.keypair = {
	call: function() {
		let r = exec('openssl genpkey -algorithm x25519 -outform DER 2>/dev/null');
		if (r.code != 0 || length(r.out) < 32)
			return { error: 'openssl could not generate an x25519 key.' };
		let priv = base32(substr(r.out, length(r.out) - 32));
		return { private_key: priv, public_key: public_key(priv) };
	}
};

methods.pubkey = {
	args: { private_key: '' },
	call: function(req) {
		if (!valid_key(req.args.private_key))
			return { error: 'The private key must be 52 characters of base32 (A-Z, 2-7).' };
		let pub = public_key(req.args.private_key);
		if (!pub) return { error: 'openssl could not derive a public key from this private key.' };
		return { public_key: pub };
	}
};

methods.links = {
	args: { profile: '' },
	call: function(req) {
		let sid = req.args.profile;
		if (!valid_sid(sid)) return { error: 'Invalid profile.' };
		let uci = cursor();
		uci.load(CFG);
		if (uci.get(CFG, sid) != 'profile')
			return { error: 'Unknown profile. Click Save & Apply first.' };
		let p = uci.get_all(CFG, sid);
		let main = uci.get_all(CFG, 'main') ?? {};
		if (p.enabled == '0') return { error: 'This profile is switched off; its key would not work.' };
		if (!valid_key(p.private_key ?? '')) return { error: 'The profile has no valid private key.' };
		let addr = onion();
		if (!addr) return { error: 'The onion address is not known yet: switch the service on, apply and wait for it to start.' };
		let name = p.name || sid;
		let ports = (type(main.port) == 'array') ? main.port : (main.port ? [ main.port ] : []);
		return {
			name: name,
			onion: addr,
			auth_line: `${replace(addr, '.onion', '')}:descriptor:x25519:${p.private_key}`,
			auth_file: `${name}.auth_private`,
			ports: ports,
			xray_port: xray_port(ports)
		};
	}
};

methods.config = {
	call: function() {
		return { config: readfile(CONF) ?? '', path: CONF, clients: lsdir(CLIENTS) ?? [] };
	}
};

methods.update_bridges = {
	call: function() {
		let r = stat(BRUN);
		if (r != null && time() - r.mtime < 600)
			return { running: true };
		exec(`setsid ${UPDATE} >/dev/null 2>&1 </dev/null &`);
		return { started: true };
	}
};

methods.log = {
	call: function() {
		return { log: tail(exec(`logread 2>/dev/null | grep -E 'tunnel-tor|Tor\\['`).out, 200) };
	}
};

methods.restart = {
	call: function() {
		let r = exec('/etc/init.d/tor restart 2>&1');
		return { ok: (r.code == 0), log: trim(r.out) };
	}
};

return { 'tunnel-tor': methods };
