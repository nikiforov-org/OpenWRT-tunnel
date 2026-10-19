'use strict';

import { access, popen, readfile, writefile, mkdir, unlink } from 'fs';
import { cursor } from 'uci';

const CFG   = 'tunnel_tailscale';
const RUN   = '/tmp/tunnel_tailscale';
const ERROR = `${RUN}/error`;
const LOGIN_OUT = `${RUN}/login.out`;
const TS    = '/usr/sbin/tailscale';
const INIT  = '/etc/init.d/tunnel_tailscale';
const ZONE  = 'tunnel_tailscale';

function exec(command) {
	let p = popen(command, 'r');
	if (p == null)
		return { code: -1, out: '' };
	let out = p.read('all') ?? '';
	return { code: p.close(), out: out };
}

function tail(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, length(lines) - n);
	return join('\n', lines);
}

function ts_status() {
	if (access(TS, 'x') != true) return null;
	let r = exec(`${TS} status --json 2>/dev/null`);
	try { return json(r.out); } catch (e) { return null; }
}

function login_url() {
	let m = match(readfile(LOGIN_OUT) ?? '', /(https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+)/);
	return m ? m[1] : '';
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		uci.load('firewall');
		let main = uci.get_all(CFG, 'main') ?? {};
		let st = ts_status();
		let self = st?.Self ?? {};
		let ips = (type(self.TailscaleIPs) == 'array') ? self.TailscaleIPs : [];
		let allowed = (type(self.AllowedIPs) == 'array') ? self.AllowedIPs : [];
		let primary = (type(self.PrimaryRoutes) == 'array') ? self.PrimaryRoutes : [];
		let peers = [];
		for (let k, p in (st?.Peer ?? {})) {
			let pips = (type(p.TailscaleIPs) == 'array') ? p.TailscaleIPs : [];
			push(peers, { hostname: p.HostName ?? '', dns_name: p.DNSName ?? '', ip: pips[0] ?? '', os: p.OS ?? '',
				online: (p.Online == true), exit_node: (p.ExitNodeOption == true), last_seen: p.LastSeen ?? '' });
		}
		sort(peers, (a, b) => (b.online - a.online) || (a.hostname < b.hostname ? -1 : 1));
		let state = st?.BackendState ?? '';
		return {
			installed: (access(TS, 'x') == true),
			running: (exec('pidof tailscaled >/dev/null 2>&1').code == 0),
			enabled: (main.enabled == '1'),
			local_access: (main.local_access != '0'),
			state: state,
			version: st?.Version ?? '',
			hostname: self.HostName ?? '',
			dns_name: rtrim(self.DNSName ?? '', '.'),
			ipv4: filter(ips, ip => index(ip, ':') < 0)[0] ?? '',
			ipv6: filter(ips, ip => index(ip, ':') >= 0)[0] ?? '',
			tailnet: st?.CurrentTailnet?.Name ?? '',
			magic_dns: st?.MagicDNSSuffix ?? '',
			exit_node_advertised: (self.ExitNodeOption == true),
			exit_node_approved: ('0.0.0.0/0' in allowed),
			routes_approved: filter(primary, r => r != '0.0.0.0/0' && r != '::/0'),
			login_url: (state == 'NeedsLogin') ? login_url() : '',
			peers: peers,
			zone: (uci.get('firewall', ZONE) == 'zone'),
			error: trim(readfile(ERROR) ?? '')
		};
	}
};

// starts "tailscale login" in the background and returns the link to open; once the login
// is done the preferences are applied by a reload of this package's init script
methods.login_link = {
	call: function() {
		let st = ts_status();
		if (!st) return { error: 'tailscaled is not running. Tick "Run Tailscale" and click "Save & Apply" first.' };
		if (st.BackendState != 'NeedsLogin' && st.BackendState != 'NoState')
			return { error: 'This router is already logged in.' };
		let url = login_url();
		if (!url) {
			mkdir(RUN, 0o755);
			unlink(LOGIN_OUT);
			exec(`setsid sh -c ${"'" + TS + " login --timeout=15m > " + LOGIN_OUT + " 2>&1; " + INIT + " reload'"} >/dev/null 2>&1 </dev/null &`);
			for (let i = 0; i < 15 && !url; i++) {
				system('sleep 1');
				url = login_url();
			}
		}
		if (!url) return { error: 'tailscale login gave no link: ' + trim(tail(readfile(LOGIN_OUT) ?? '', 2)) };
		return { ok: true, url: url };
	}
};

methods.logout = {
	call: function() {
		let r = exec(`${TS} logout 2>&1`);
		unlink(LOGIN_OUT);
		return { ok: (r.code == 0), log: trim(r.out) };
	}
};

methods.log = {
	call: function() {
		return { log: tail(exec(`logread 2>/dev/null | grep -E 'tunnel_tailscale|tailscale'`).out, 200) };
	}
};

methods.restart = {
	call: function() {
		let r = exec('/etc/init.d/tailscale restart 2>&1');
		if (r.code == 0) exec(`${INIT} reload 2>&1`);
		return { ok: (r.code == 0), log: trim(r.out) };
	}
};

return { 'tunnel_tailscale': methods };
