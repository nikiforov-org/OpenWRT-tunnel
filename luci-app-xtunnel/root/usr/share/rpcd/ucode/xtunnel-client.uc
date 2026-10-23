'use strict';

import { access, readfile, stat, lsdir } from 'fs';
import { cursor } from 'uci';
import { RUN, exec, instance, active_link, locked, uplink, tor_running, TOR_SOCKS } from 'xtunnel-client.common';

const CFG     = 'xtunnel-client';
const CONF    = '/etc/xtunnel-client/config.json';
const AUTO    = '/etc/xtunnel-client/auto.json';
const ERROR   = `${RUN}/error`;
const STATE   = `${RUN}/state.json`;
const MEASURE = `${RUN}/measure.json`;
const HISTORY = `${RUN}/history.json`;
const XRAY    = '/usr/bin/xray';

function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n) lines = slice(lines, length(lines) - n);
	return join('\n', lines);
}

function read_json(path, dflt) {
	let v = null;
	try { v = json(readfile(path) ?? ''); } catch (e) { v = null; }
	return (type(v) == type(dflt)) ? v : dflt;
}

// the xray version, read again only when the binary changed (rpcd keeps this plugin loaded)
let version = { key: null, value: '' };
function xray_version() {
	let st = stat(XRAY), key = st ? `${st.mtime}/${st.size}` : null;
	if (key != version.key) {
		let m = key ? match(exec(`${XRAY} version 2>/dev/null`).out, /Xray ([0-9.]+)/) : null;
		version = { key: key, value: m ? m[1] : '' };
	}
	return version.value;
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		let main = uci.get_all(CFG, 'main') ?? {};
		let inst = instance();
		let running = (inst != null);
		let state = read_json(STATE, {});
		let now = active_link(inst, state);
		let measure = read_json(MEASURE, {}), history = read_json(HISTORY, {});
		let in_config = {};
		for (let c in (state.clients ?? [])) in_config[c.tag] = true;
		// the router's tor, while links through it are in the configuration
		let tor_used = (length(filter(state.clients ?? [], c => c.tor)) > 0);
		let tor = { used: tor_used, running: tor_used && tor_running(), socks: `${TOR_SOCKS.address}:${TOR_SOCKS.port}`,
		            keys: length(filter(lsdir('/etc/tor/xtunnel-client') ?? [], f => match(f, /\.auth_private$/))) };
		// every link of the profiles as sync saw it, with what the router knows about it now
		let links = [];
		for (let l in (state.links ?? [])) {
			push(links, { ...l,
				ready: (running && l.enabled && !l.error && in_config[l.tag] == true && (!l.tor || tor.running)),
				tor_down: (l.tor && in_config[l.tag] == true && !tor.running),
				active: (l.tag == now),
				measure: measure.clients?.[l.tag] ?? null,
				history: history[l.tag] ?? [] });
		}
		let st = stat(CONF);
		delete state.links;
		return {
			installed: (access(XRAY, 'x') == true),
			version: xray_version(),
			enabled: (main.enabled == '1'),
			mode: main.mode ?? 'auto',
			active_config: main.active ?? '',
			active_now: now,
			auto: read_json(AUTO, {}),
			running: running,
			pid: inst?.pid ?? 0,
			config_time: st ? st.mtime : null,
			state: state,
			links: links,
			measure: { time: measure.time ?? 0, decision: measure.decision ?? '', bytes: measure.bytes ?? 0, health: measure.health ?? null },
			uplink: uplink(),
			tor: tor,
			measuring: locked(`${RUN}/measure.lock`),
			updating: locked(`${RUN}/sources.lock`),
			error: trim(readfile(ERROR) ?? '') || trim(readfile('/tmp/xtunnel-xray/error') ?? ''),
			log_last: (main.enabled == '1' && !running) ? tail(exec(`logread 2>/dev/null | grep -E '${CFG}|xray\\['`).out, 3) : ''
		};
	}
};

methods.measure = {
	call: function() {
		if (locked(`${RUN}/measure.lock`)) return { running: true };
		exec('setsid /usr/libexec/xtunnel-client/measure now >/dev/null 2>&1 </dev/null &');
		return { started: true };
	}
};

methods.update_sources = {
	call: function() {
		if (locked(`${RUN}/sources.lock`)) return { running: true };
		exec('setsid /usr/libexec/xtunnel-client/sources >/dev/null 2>&1 </dev/null &');
		return { started: true };
	}
};

methods.log = {
	call: function() {
		return { log: tail(exec(`logread 2>/dev/null | grep -E 'xtunnel-client|xray\\['`).out, 200) };
	}
};

methods.config = {
	call: function() {
		return { config: readfile(CONF) ?? '', path: CONF };
	}
};

methods.restart = {
	call: function() {
		let r = exec(`/etc/init.d/${CFG} restart 2>&1`);
		return { ok: (r.code == 0), log: trim(r.out) };
	}
};

return { 'xtunnel-client': methods };
