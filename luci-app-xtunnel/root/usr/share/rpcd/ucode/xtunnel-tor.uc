'use strict';

// The router's tor for the Server page (section "Tor"): its state, the bridges, the keys of the profiles.
// The settings are those of /etc/config/xtunnel-server (section "tor"); /usr/libexec/xtunnel-tor/sync
// applies them together with the client keys of /etc/config/xtunnel-client.

import { access, readfile, stat, lsdir } from 'fs';
import { cursor } from 'uci';
import { RUN, CONF, exec, valid_key, public_key, keypair, tor_instance, bootstrap_phase } from 'xtunnel-tor.common';

const SRV     = 'xtunnel-server';
const DIR     = '/etc/xtunnel-tor';
const HS      = '/etc/tor/xtunnel-tor';
const CLIENTS = `${HS}/authorized_clients`;
const ERROR   = `${RUN}/error`;
const TOR     = '/usr/sbin/tor';
const SHIPPED = '/usr/share/xtunnel-tor/bridges.txt';
const LIST    = `${DIR}/bridges.txt`;
const BSTATE  = `${DIR}/bridges.state`;
const BRUN    = `${RUN}/bridges.running`;
const UPDATE  = '/usr/libexec/xtunnel-tor/bridges-update';

function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, length(lines) - n);
	return join('\n', lines);
}

// the names a tor client can map to the onion address (MapAddress NAME.onion ADDRESS)
function aliases(main) {
	let out = [];
	for (let a in ((type(main.alias) == 'array') ? main.alias : (main.alias ? [ main.alias ] : []))) {
		a = lc(trim(a));
		if (match(a, /^[a-z0-9_-]{1,63}$/) && !(a in out)) push(out, a);
	}
	return out;
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
		uci.load(SRV);
		let main = uci.get_all(SRV, 'tor') ?? {};
		let enabled = (main.enabled == '1');
		let inst = tor_instance();
		let running = (inst != null);
		// the server profiles and whether the onion service lets their Tor key in
		let profiles = [];
		uci.foreach(SRV, 'profile', function(s) {
			push(profiles, { sid: s['.name'], name: trim(s.name ?? ''), enabled: (s.enabled != '0'), key: valid_key(trim(s.tor_key ?? '')),
				authorized: (access(`${CLIENTS}/${s['.name']}.auth`) == true) });
		});
		let st = stat(CONF);
		let bs = running ? bootstrap(inst) : null;
		return {
			installed: (access(TOR, 'x') == true),
			version: tor_version(),
			enabled: enabled,
			in_effect: (st != null),
			// the onion service in the configuration in effect; sync leaves it out without an authorized client
			published: (index(readfile(CONF) ?? '', '\nHiddenServiceDir ') >= 0),
			no_profile: enabled && !length(filter(profiles, p => p.enabled && p.key)),
			client_keys: length(filter(lsdir('/etc/tor/xtunnel-client') ?? [], f => match(f, /\.auth_private$/))),
			running: running,
			bootstrap: bs ? bs.percent : (running ? 0 : null),
			bootstrap_text: bs ? bs.text : '',
			onion: onion(),
			aliases: aliases(main),
			ports: (type(main.port) == 'array') ? main.port : (main.port ? [ main.port ] : []),
			bridges: main.bridges ?? 'builtin',
			bridges_info: bridges_info(main),
			snowflake: snowflake_info(main),
			profiles: profiles,
			config_time: st ? st.mtime : null,
			error: trim(readfile(ERROR) ?? ''),
			log_last: (st != null && !running) ? tail(exec(`logread 2>/dev/null | grep -E 'xtunnel-tor|Tor\\['`).out, 3) : ''
		};
	}
};

methods.keypair = {
	call: function() {
		let k = keypair();
		return k ?? { error: 'xray could not generate an x25519 key.' };
	}
};

methods.pubkey = {
	args: { private_key: '' },
	call: function(req) {
		if (!valid_key(req.args.private_key))
			return { error: 'The key must be 52 characters of base32 (A-Z, 2-7).' };
		let pub = public_key(req.args.private_key);
		if (!pub) return { error: 'xray could not derive a public key from this key.' };
		return { public_key: pub };
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
		return { log: tail(exec(`logread 2>/dev/null | grep -E 'xtunnel-tor|Tor\\['`).out, 200) };
	}
};

methods.restart = {
	call: function() {
		let r = exec('/etc/init.d/tor restart 2>&1');
		return { ok: (r.code == 0), log: trim(r.out) };
	}
};

return { 'xtunnel-tor': methods };
