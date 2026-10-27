'use strict';

import { access, readfile, stat } from 'fs';
import { cursor } from 'uci';
import { XRAY, exec, read_json, locked, xray_version, syslog_tail, restart, spawn } from 'xtunnel.common';
import { RUN, instance, active_link, uplink } from 'xtunnel-client.common';

const CFG     = 'xtunnel-client';
const CONF    = '/etc/xtunnel-client/config.json';
const AUTO    = '/etc/xtunnel-client/auto.json';
const ERROR   = `${RUN}/error`;
const STATE   = `${RUN}/state.json`;
const MEASURE = `${RUN}/measure.json`;
const HISTORY = `${RUN}/history.json`;
const LOG     = 'xtunnel-client|xray\\[';           // its lines in the system log

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		let main = uci.get_all(CFG, 'main') ?? {};
		let inst = instance();
		let up = (inst != null);
		let state = read_json(STATE, {});
		let now = active_link(inst, state);
		let measure = read_json(MEASURE, {}), history = read_json(HISTORY, {});
		let in_config = {};
		for (let c in (state.clients ?? [])) in_config[c.tag] = true;
		// every link of the profiles as sync saw it, with what the router knows about it now
		let links = [];
		for (let l in (state.links ?? [])) {
			push(links, { ...l,
				ready: (up && l.enabled && !l.error && in_config[l.tag] == true),
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
			running: up,
			pid: inst?.pid ?? 0,
			config_time: st ? st.mtime : null,
			state: state,
			links: links,
			measure: { time: measure.time ?? 0, decision: measure.decision ?? '', bytes: measure.bytes ?? 0, health: measure.health ?? null },
			uplink: uplink(),
			measuring: locked(`${RUN}/measure.lock`),
			updating: locked(`${RUN}/sources.lock`),
			error: trim(readfile(ERROR) ?? '') || trim(readfile('/tmp/xtunnel-xray/error') ?? ''),
			log_last: (main.enabled == '1' && !up) ? syslog_tail(LOG, 3) : ''
		};
	}
};

methods.measure = {
	call: function() {
		if (locked(`${RUN}/measure.lock`)) return { running: true };
		spawn('/usr/libexec/xtunnel-client/measure now');
		return { started: true };
	}
};

methods.update_sources = {
	call: function() {
		if (locked(`${RUN}/sources.lock`)) return { running: true };
		spawn('/usr/libexec/xtunnel-client/sources');
		return { started: true };
	}
};

methods.log = {
	call: function() {
		return { log: syslog_tail(LOG, 200) };
	}
};

methods.config = {
	call: function() {
		return { config: readfile(CONF) ?? '', path: CONF };
	}
};

methods.restart = {
	call: function() {
		return restart(`/etc/init.d/${CFG}`);
	}
};

return { 'xtunnel-client': methods };
