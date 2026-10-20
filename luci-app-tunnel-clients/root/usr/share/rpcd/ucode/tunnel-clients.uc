'use strict';

import { access, readfile, stat } from 'fs';
import { cursor } from 'uci';
import { RUN, exec, descriptors } from 'tunnel-clients.common';

const CFG     = 'tunnel-clients';
const CONF    = '/etc/tunnel-clients/config.json';
const AUTO    = '/etc/tunnel-clients/auto.json';
const ERROR   = `${RUN}/error`;
const STATE   = `${RUN}/state.json`;
const MEASURE = `${RUN}/measure.json`;
const HISTORY = `${RUN}/history.json`;
const XRAY    = '/usr/bin/xray';
const API     = '127.0.0.1:61085';

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

function instance() {
	try { return json(exec(`ubus call service list '{"name":"${CFG}"}'`).out)?.[CFG]?.instances?.xray ?? null; } catch (e) { return null; }
}

function current_active() {
	return trim(exec(`${XRAY} api bi --server=${API} active 2>/dev/null | awk '/Selecting Override:/{s="o";next} /Selects:/{s="s";next} /^[ \\t]*[0-9]+[ \\t]+/{if(s=="o"&&o=="")o=$2; if(s=="s"&&x=="")x=$2} END{print (o!="")?o:x}'`).out);
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		let main = uci.get_all(CFG, 'main') ?? {};
		let inst = instance();
		let running = (inst != null && inst.running == true);
		let now = running ? current_active() : '';
		let measure = read_json(MEASURE, {}), history = read_json(HISTORY, {});
		let packages = [];
		for (let d in descriptors()) {
			let clients = [];
			for (let c in d.clients) {
				let cc = { ...c, package: d.package, title: d.title };
				delete cc.outbound;                                  // not needed by the page (the links are shown as they are)
				cc.ready = (running && c.enabled && !c.error);
				cc.active = (c.tag == now);
				cc.measure = measure.clients?.[c.tag] ?? null;
				cc.history = history[c.tag] ?? [];
				push(clients, cc);
			}
			push(packages, { package: d.package, title: d.title, description: d.description, config: d.config, schemes: d.schemes, error: d.error, clients: clients });
		}
		let version = match(exec(`${XRAY} version 2>/dev/null | head -1`).out, /Xray ([0-9.]+)/);
		let st = stat(CONF);
		return {
			installed: (access(XRAY, 'x') == true),
			version: version ? version[1] : '',
			enabled: (main.enabled == '1'),
			mode: main.mode ?? 'auto',
			active_config: main.active ?? '',
			active_now: now,
			auto: read_json(AUTO, {}),
			running: running,
			pid: inst?.pid ?? 0,
			config_time: st ? st.mtime : null,
			state: read_json(STATE, {}),
			measure: { time: measure.time ?? 0, decision: measure.decision ?? '', bytes: measure.bytes ?? 0, health: measure.health ?? null },
			measuring: (stat(`${RUN}/measure.lock`) != null),
			updating: (stat(`${RUN}/sources.lock`) != null),
			packages: packages,
			error: trim(readfile(ERROR) ?? ''),
			log_last: (main.enabled == '1' && !running) ? tail(exec(`logread 2>/dev/null | grep -E '${CFG}|xray\\['`).out, 3) : ''
		};
	}
};

methods.measure = {
	call: function() {
		if (stat(`${RUN}/measure.lock`) != null) return { running: true };
		exec('setsid /usr/libexec/tunnel-clients/measure >/dev/null 2>&1 </dev/null &');
		return { started: true };
	}
};

methods.update_sources = {
	call: function() {
		if (stat(`${RUN}/sources.lock`) != null) return { running: true };
		exec('setsid /usr/libexec/tunnel-clients/sources >/dev/null 2>&1 </dev/null &');
		return { started: true };
	}
};

methods.log = {
	call: function() {
		return { log: tail(exec(`logread 2>/dev/null | grep -E 'tunnel-client|xray\\['`).out, 200) };
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

return { 'tunnel-clients': methods };
