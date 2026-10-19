'use strict';

import { access, popen, readfile, writefile, mkdir, unlink, chmod, stat, lsdir } from 'fs';
import { cursor } from 'uci';

const CFG     = 'tunnel_server-tor';
const DIR     = '/etc/tunnel_server-tor';
const CONF    = `${DIR}/torrc`;
const HS      = '/etc/tor/tunnel_server-tor';
const CLIENTS = `${HS}/authorized_clients`;
const RUN     = '/tmp/tunnel_server-tor';
const ERROR   = `${RUN}/error`;
const TOR     = '/usr/sbin/tor';
const INIT    = '/etc/init.d/tunnel_server-tor';

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

function valid_sid(s) {
	return type(s) == 'string' && match(s, /^[A-Za-z0-9_]{1,64}$/) != null;
}

function base32(bytes) {
	const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let out = '', bits = 0, val = 0;
	for (let i = 0; i < length(bytes); i++) {
		val = ((val << 8) | ord(bytes, i)) & 0x1fff;
		bits += 8;
		while (bits >= 5) { out += substr(A, (val >> (bits - 5)) & 31, 1); bits -= 5; }
	}
	if (bits > 0) out += substr(A, (val << (5 - bits)) & 31, 1);
	return out;
}

function base32_decode(s) {
	const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let out = '', bits = 0, val = 0;
	for (let i = 0; i < length(s); i++) {
		let v = index(A, uc(substr(s, i, 1)));
		if (v < 0) return null;
		val = ((val << 5) | v) & 0x1fff;
		bits += 5;
		if (bits >= 8) { out += chr((val >> (bits - 8)) & 255); bits -= 8; }
	}
	return out;
}

function valid_key(s) {
	return type(s) == 'string' && match(s, /^[A-Z2-7]{52}$/) != null;
}

function public_key(priv) {
	if (!valid_key(priv)) return '';
	let raw = base32_decode(priv);
	if (raw == null || length(raw) != 32) return '';
	mkdir(RUN, 0o700);
	let pem = `${RUN}/key-${time()}.pem`;
	writefile(pem, "-----BEGIN PRIVATE KEY-----\n" + b64enc(hexdec('302e020100300506032b656e04220420') + raw) + "\n-----END PRIVATE KEY-----\n");
	chmod(pem, 0o600);
	let r = exec(`openssl pkey -in ${shq(pem)} -pubout -outform DER 2>/dev/null`);
	unlink(pem);
	if (r.code != 0 || length(r.out) < 32) return '';
	return base32(substr(r.out, length(r.out) - 32));
}

function onion() {
	return trim(readfile(`${HS}/hostname`) ?? '');
}

// the last bootstrap message of the running tor process
function bootstrap(pid) {
	let out = exec(`logread 2>/dev/null | grep -E 'Tor\\[${pid}\\]: Bootstrapped [0-9]+%' | tail -1`).out;
	let m = match(out, /Bootstrapped ([0-9]+)% \(([a-z_]+)\): ?(.*)$/);
	if (!m) return null;
	return { percent: int(m[1]), text: (m[2] == 'done') ? '' : trim(m[3]) };
}

const methods = {};

methods.status = {
	call: function() {
		let uci = cursor();
		uci.load(CFG);
		let main = uci.get_all(CFG, 'main') ?? {};
		let enabled = (main.enabled == '1');
		let pid = trim(exec('pidof tor 2>/dev/null').out);
		let running = (pid != '');
		let profiles = [];
		uci.foreach(CFG, 'profile', function(s) {
			let name = trim(s.name ?? '');
			push(profiles, { sid: s['.name'], name: name, enabled: (s.enabled != '0'),
				authorized: (name != '' && access(`${CLIENTS}/${name}.auth`) == true) });
		});
		let st = stat(CONF);
		let bs = running ? bootstrap(split(pid, ' ')[0]) : null;
		let version = match(exec(`${TOR} --version 2>/dev/null | head -1`).out, /Tor version ([0-9]+(\.[0-9]+)*)/);
		return {
			installed: (access(TOR, 'x') == true),
			version: version ? version[1] : '',
			enabled: enabled,
			running: running,
			bootstrap: bs ? bs.percent : (running ? 0 : null),
			bootstrap_text: bs ? bs.text : '',
			onion: onion(),
			ports: (type(main.port) == 'array') ? main.port : (main.port ? [ main.port ] : []),
			bridges: main.bridges ?? 'builtin',
			profiles: profiles,
			config_time: st ? st.mtime : null,
			error: trim(readfile(ERROR) ?? ''),
			log_last: (enabled && !running) ? tail(exec(`logread 2>/dev/null | grep -E 'tunnel_server-tor|Tor\\['`).out, 3) : ''
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
			xray: (index(ports, '8443') >= 0 && uci.load('tunnel_server-xray') && uci.get('tunnel_server-xray', 'main', 'enabled') == '1')
		};
	}
};

methods.config = {
	call: function() {
		return { config: readfile(CONF) ?? '', path: CONF, clients: lsdir(CLIENTS) ?? [] };
	}
};

methods.log = {
	call: function() {
		return { log: tail(exec(`logread 2>/dev/null | grep -E 'tunnel_server-tor|Tor\\['`).out, 200) };
	}
};

methods.restart = {
	call: function() {
		let r = exec('/etc/init.d/tor restart 2>&1');
		return { ok: (r.code == 0), log: trim(r.out) };
	}
};

return { 'tunnel_server-tor': methods };
