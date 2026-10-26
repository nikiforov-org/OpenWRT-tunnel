'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require uqr';
'require xtunnel.common as common';

var CFG = 'xtunnel-server';

var callStatus  = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callKeypair = rpc.declare({ object: CFG, method: 'keypair', expect: {} });
var callPubkey  = rpc.declare({ object: CFG, method: 'pubkey', params: [ 'private_key' ], expect: {} });
var callLinks   = rpc.declare({ object: CFG, method: 'links', params: [ 'profile' ], expect: {} });
var callLog     = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callConfig  = rpc.declare({ object: CFG, method: 'config', expect: {} });
var callRestart = rpc.declare({ object: CFG, method: 'restart', expect: {} });

/* the router's tor (section "tor" of this config; applied by xtunnel-tor, which also takes the client's keys) */
var TOR = 'xtunnel-tor';
var callTorStatus  = rpc.declare({ object: TOR, method: 'status', expect: {} });
var callTorKeypair = rpc.declare({ object: TOR, method: 'keypair', expect: {} });
var callTorPubkey  = rpc.declare({ object: TOR, method: 'pubkey', params: [ 'private_key' ], expect: {} });
var callTorConfig  = rpc.declare({ object: TOR, method: 'config', expect: {} });
var callTorLog     = rpc.declare({ object: TOR, method: 'log', expect: {} });
var callTorRestart = rpc.declare({ object: TOR, method: 'restart', expect: {} });
var callTorUpdateBridges = rpc.declare({ object: TOR, method: 'update_bridges', expect: {} });

var COLOR = common.COLOR, span = common.span, timeAgo = common.timeAgo, daysLeft = common.daysLeft;
var randomHex = common.randomHex, copyText = common.copyText;
var XHTTP_MODES = [ 'auto', 'packet-up', 'stream-up', 'stream-one' ];
var TRANSPORT = { vision: 'TCP + Vision', xhttp: 'XHTTP', hysteria2: 'Hysteria2' };
var PROTO = { vision: 'tcp', xhttp: 'tcp', hysteria2: 'udp' };
var KEY_RE = /^[A-Za-z0-9_-]{43}$/;
var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function hex(bytes) {
	return Array.from(bytes, function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

function randomUUID() {
	var b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	var h = hex(b);
	return h.substr(0, 8) + '-' + h.substr(8, 4) + '-' + h.substr(12, 4) + '-' + h.substr(16, 4) + '-' + h.substr(20);
}

/* the widget of a form option with buttons next to it */
function withButtons(node, buttons) {
	return E('div', { 'style': 'display:flex; flex-wrap:wrap; align-items:flex-start; gap:.5em' }, [ node ].concat(buttons));
}

function button(title, fn) {
	return E('button', { 'class': 'btn cbi-button', 'click': function(ev) { ev.preventDefault(); return fn(ev); } }, title);
}

/* letters and digits; bytes above the largest multiple of the alphabet size are drawn again */
function randomPassword(n) {
	var out = '', limit = 256 - (256 % ALPHABET.length);
	while (out.length < n) {
		var bytes = crypto.getRandomValues(new Uint8Array(n * 2));
		for (var i = 0; i < bytes.length && out.length < n; i++)
			if (bytes[i] < limit) out += ALPHABET[bytes[i] % ALPHABET.length];
	}
	return out;
}

function qrNode(text) {
	var svg = null;
	try { svg = uqr.renderSVG(text, { pixelSize: 4 }); } catch (e) {}
	return E('div', { 'style': 'margin:1em auto; width:240px' },
		svg ? Object.assign(E(svg), { style: 'width:100%; height:auto' }) : span(COLOR.dim, _('QR code unavailable')));
}

return view.extend({
	status: {},
	tor: {},
	pendingTorKey: null,
	torPublicKeyFor: {},

	load: function() {
		return Promise.all([ L.resolveDefault(callStatus(), {}), L.resolveDefault(callTorStatus(), {}) ]).then(L.bind(function(r) {
			this.status = r[0] || {};
			this.tor = r[1] || {};
		}, this));
	},

	/* ---------- status cells ---------- */

	overviewServer: function() {
		var st = this.status;
		if (!st.installed)
			return span(COLOR.bad, _('xray is not installed on the router (/usr/bin/xray of the package xtunnel-core, a dependency of this package).'));
		if (!st.enabled)
			return span(COLOR.dim, _('Off'));
		if (st.running) {
			var run = span(COLOR.ok, _('Running') + (st.version ? ' (Xray ' + st.version + ')' : ''));
			// the target is the router's own site: its certificate is that of the name the site answers as
			var site = st.site || {}, names = st.server_names || [];
			if (/^(127\.0\.0\.1|localhost):(443|4443)$/.test(st.target || '') && site.cert_host && names.length && names.indexOf(site.cert_host) < 0)
				return E('div', {}, [ run, E('div', { 'style': 'color:' + COLOR.warn + '; margin-top:.3em' },
					_('The server names (%s) are not on the certificate of the router\'s site, which answers as %s: connections without a client key get a certificate for another name. Enter %s under "Server names".').format(names.join(', '), site.cert_host, site.cert_host)) ]);
			return run;
		}
		var lines = [ span(COLOR.bad, _('Not running')) ];
		if (st.log_last)
			lines.push(E('pre', { 'style': 'color:' + COLOR.dim + '; white-space:pre-wrap; margin:.3em 0 0; font-size:90%' }, st.log_last));
		return E('div', {}, lines);
	},

	/* the ports of the transports open from the Internet: "443/tcp (TCP + XTLS-Vision)" … */
	openPorts: function() {
		var fw = this.status.firewall || {}, parts = [];
		for (var k in TRANSPORT)
			if (fw[k]) parts.push(fw[k] + '/' + PROTO[k] + ' (' + TRANSPORT[k] + ')');
		return parts;
	},

	overviewAccess: function() {
		var parts = this.openPorts();
		return parts.length
			? span(COLOR.ok, _('Open from the Internet: %s (firewall rules "xtunnel-server: …")').format(parts.join(', ')))
			: span(COLOR.dim, _('Closed: no port is open from the Internet'));
	},

	overviewCert: function() {
		var c = this.status.cert;
		if (!c)
			return span(COLOR.dim, _('Only the Hysteria2 transport uses a certificate; it is off'));
		if (c.error)
			return span(COLOR.warn, c.error);
		var n = daysLeft(c.expires);
		var col = (c.valid && n != null && n > 14) ? COLOR.ok : COLOR.bad;
		if (n != null && n <= 30 && n > 14) col = COLOR.warn;
		return E('span', {}, [
			span(col, (n != null && n >= 0) ? _('%s: valid, %d days left').format(c.cn || c.server_name, n) : _('%s: expired').format(c.cn || c.server_name)),
			E('span', { 'style': 'color:' + COLOR.dim }, c.source == 'ddns' ? ' ' + _('(from the Dynamic DNS page)') : ' ' + c.path)
		]);
	},

	overviewConfig: function() {
		var st = this.status;
		return common.fileState(st.error, st.enabled && st.config_time, '/etc/xtunnel-server/config.json', st.enabled ? null : _('No configuration file while the server is off'));
	},

	/* ---------- Tor ---------- */

	torService: function() {
		var t = this.tor;
		if (!t.installed)
			return span(COLOR.bad, _('tor is not installed on the router (/usr/sbin/tor of the package xtunnel-core, a dependency of this package).'));
		if (!t.in_effect)
			return t.no_profile ? span(COLOR.warn, _('Off: the onion service below is not published without an enabled profile with a Tor key'))
				: span(COLOR.dim, _('Off: tor runs while the onion service below is on or the Client page uses links through Tor'));
		var uses = [];
		if (t.published) uses.push(_('the onion service'));
		if (t.client_keys) uses.push(_('the keys of %d onion service(s) for the Client page').format(t.client_keys));
		var why = uses.length ? ' — ' + _('for %s').format(uses.join(', ')) : ' — ' + _('for the links through Tor of the Client page');
		if (t.running) {
			var v = t.version ? ' (tor ' + t.version + ')' : '';
			if (t.bootstrap == null)
				return span(COLOR.ok, _('Running') + v + why);
			if (t.bootstrap >= 100)
				return span(COLOR.ok, _('Running, connected to the Tor network') + v + why);
			return span(COLOR.warn, _('Running, connecting to the Tor network: %d%%').format(t.bootstrap) + (t.bootstrap_text ? ' — ' + t.bootstrap_text : '') + v);
		}
		var lines = [ span(COLOR.bad, _('Not running')) ];
		if (t.log_last)
			lines.push(E('pre', { 'style': 'color:' + COLOR.dim + '; white-space:pre-wrap; margin:.3em 0 0; font-size:90%' }, t.log_last));
		return E('div', {}, lines);
	},

	torAddress: function() {
		var t = this.tor;
		var none = _('Not published: the service needs an enabled profile with a Tor key (tor lets every client in to an onion service without authorized clients).');
		if (!t.onion)
			return t.no_profile ? span(COLOR.warn, none)
				: span(COLOR.dim, t.enabled ? _('Not known yet: it appears when tor starts the service') : _('Appears once the service runs'));
		var al = (t.aliases || []).map(function(a) { return a + '.onion'; });
		return E('span', {}, [
			E('code', { 'style': 'user-select:all' }, t.onion), ' ',
			E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(t.onion); } }, _('Copy')),
			al.length ? E('div', { 'style': 'margin-top:.3em' }, _('Names for tor clients (MapAddress): %s').format(al.join(', '))) : '',
			t.no_profile ? E('div', { 'style': 'color:' + COLOR.warn + '; margin-top:.3em' }, none)
			: E('div', { 'style': 'color:' + COLOR.dim + '; margin-top:.3em' }, t.enabled
				? _('Reachable through Tor only with the Tor keys of the profiles, a minute or two after tor is connected. Ports: %s.').format((t.ports || []).join(', ') || '—')
				: _('The service is off; the address stays and comes back with it.'))
		]);
	},

	torBridges: function() {
		var t = this.tor, b = t.bridges_info || {}, self = this;
		if (b.mode == 'none')
			return span(COLOR.dim, _('No bridges: tor connects directly'));
		var sf = this.torSnowflake();
		if (b.mode == 'custom')
			return E('span', {}, [ span(null, _('The bridge lines entered below')), sf ? E('div', { 'style': 'margin-top:.3em' }, sf) : '' ]);
		var by = b.by || {}, parts = [];
		Object.keys(by).forEach(function(k) { parts.push(by[k] + ' ' + (k == 'vanilla' ? _('plain') : k)); });
		var text = _('%d lines').format(b.lines || 0) + (parts.length ? ' (' + parts.join(', ') + ')' : '');
		var s = b.state;
		if (s && s.time && !s.error)
			text += ', ' + _('updated %s for "%s" %s').format(timeAgo(s.time), s.country, s.via == 'tor' ? _('through Tor') : _('directly'));
		else if (b.source == 'shipped')
			text += ', ' + _('the list shipped with the package');
		var nodes = [ span(null, text) ];
		if (b.country) {
			nodes.push(' ', E('button', {
				'class': 'btn cbi-button', 'disabled': b.running ? 'disabled' : null,
				'click': ui.createHandlerFn(self, 'handleUpdateBridges')
			}, b.running ? _('Updating…') : _('Update bridges')));
		} else
			nodes.push(E('div', { 'style': 'color:' + COLOR.dim + '; margin-top:.3em' }, _('Set the country below and the list is refreshed daily from bridges.torproject.org.')));
		if (s && s.error)
			nodes.push(E('div', { 'style': 'color:' + COLOR.bad + '; margin-top:.3em' }, _('Last update %s: %s').format(timeAgo(s.time), s.error)));
		if (sf) nodes.push(E('div', { 'style': 'margin-top:.3em' }, sf));
		return E('span', {}, nodes);
	},

	torSnowflake: function() {
		var sf = this.tor.snowflake || {}, w = sf.watch || {}, t = w.tor || null, text;
		if (!sf.listed) return null;
		if (sf.mode == 'never') return span(COLOR.dim, _('Snowflake: not used'));
		if (!sf.others) return span(null, _('Snowflake: in use, the list has no other bridges'));
		if (sf.mode == 'always') return span(null, _('Snowflake: always in use'));
		if (sf.in_use && sf.fallback_since)
			text = span(COLOR.warn, _('Snowflake: added %s, after no working circuit through the other bridges').format(timeAgo(sf.fallback_since)));
		else if (sf.in_use)
			text = span(null, _('Snowflake: in use'));
		else
			text = span(COLOR.ok, _('Snowflake: held back while the other bridges work'));
		var check = '';
		if (w.time) {
			if (!t) check = _('checked %s: tor\'s control port did not answer');
			else if (t.established) check = _('checked %s: working circuit');
			else if (w.down_since) check = _('checked %s: no working circuit for %d min').format('%s', Math.round((w.time - w.down_since) / 60));
			else if (w.uplink === false) check = _('checked %s: no default route on the router');
			else check = _('checked %s: no working circuit');
			check = ' (' + check.format(timeAgo(w.time)) + ')';
		}
		return E('span', {}, [ text, span(COLOR.dim, check) ]);
	},

	torConfig: function() {
		var t = this.tor;
		return common.fileState(t.error, t.in_effect && t.config_time, '/etc/xtunnel-tor/torrc', t.in_effect ? null : _('No configuration file while tor is not needed'));
	},

	/* the onion service's view of a profile: its Tor key and whether the service lets it in */
	torProfileState: function(sid) {
		var t = this.tor, p = null;
		(t.profiles || []).forEach(function(x) { if (x.sid == sid) p = x; });
		if (!t.enabled) return span(COLOR.dim, '—');
		if (!p) return span(COLOR.dim, _('not saved yet'));
		if (!p.key) return span(COLOR.warn, _('no Tor key'));
		if (!p.enabled) return span(COLOR.dim, _('off'));
		if (p.authorized) return span(COLOR.ok, _('authorized'));
		return span(COLOR.warn, _('not applied yet'));
	},

	refresh: function() {
		return Promise.all([ L.resolveDefault(callStatus(), null), L.resolveDefault(callTorStatus(), null) ]).then(L.bind(function(r) {
			var el, self = this;
			if (r[0]) {
				this.status = r[0];
				if ((el = document.getElementById('tsv-ov-server'))) dom.content(el, this.overviewServer());
				common.updateRows();
			}
			if (r[1]) {
				this.tor = r[1];
				if ((el = document.getElementById('tsv-tor-service'))) dom.content(el, this.torService());
				if ((el = document.getElementById('tsv-tor-bridges'))) dom.content(el, this.torBridges());
				if ((el = document.getElementById('tsv-tor-config')))  dom.content(el, this.torConfig());
				if ((el = document.getElementById('tsv-tor-address'))) dom.content(el, this.torAddress());
				(this.tor.profiles || []).forEach(function(p) {
					var cell = document.getElementById('tsv-tor-profile-' + p.sid);
					if (cell) dom.content(cell, self.torProfileState(p.sid));
				});
			}
		}, this));
	},

	/* ---------- keys ---------- */

	/* the form is re-rendered by every store save, so the key cell is rebuilt from this state:
	   the public key (or a note) shown for the private key publicKeyFor */
	showPublicKey: function(pub, note, priv) {
		this.publicKey = pub || '';
		this.publicKeyNote = note || '';
		this.publicKeyFor = priv || '';
		var el = this.pubkeyNode;
		if (!el) return;
		dom.content(el, pub ? [
			E('code', { 'style': 'margin-right:.6em' }, pub),
			E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(pub); } }, _('Copy'))
		] : span(COLOR.dim, note || ''));
	},

	updatePublicKey: function(priv) {
		priv = String(priv || '').trim();
		if (!priv) {
			this.showPublicKey('', _('No private key yet: click "Generate keypair"'), priv);
			return Promise.resolve();
		}
		if (!KEY_RE.test(priv)) {
			this.showPublicKey('', _('The private key is not valid'), priv);
			return Promise.resolve();
		}
		this.showPublicKey('', '…', priv);
		return callPubkey(priv).then(L.bind(function(r) {
			if (this.publicKeyFor === priv)
				this.showPublicKey(r.public_key || '', r.error || _('The private key is not valid'), priv);
		}, this));
	},

	handleKeypair: function(ev) {
		return callKeypair().then(L.bind(function(r) {
			if (r.error) {
				ui.addNotification(null, E('p', r.error), 'error');
				return;
			}
			var el = this.realitySection.getUIElement('main', 'private_key');
			el.setValue(r.private_key);
			el.triggerValidation();
			this.showPublicKey(r.public_key, '', r.private_key);
			ui.addTimeLimitedNotification(null, E('p', _('New keypair generated. Click "Save & Apply" to use it; the VLESS links of existing profiles then have to be exported again.')), 8000, 'info');
		}, this));
	},

	handleAddShortId: function(ev) {
		var el = this.realitySection.getUIElement('main', 'short_id');
		el.addItem(el.node, randomHex(8), null, true);
	},

	setTransportValue: function(option, value) {
		var el = this.transportSection.getUIElement('main', option);
		el.setValue(value);
		el.triggerValidation();
	},

	/* ---------- actions ---------- */

	handleLinks: function(sid, ev) {
		return common.ensureSaved(this.map).then(L.bind(function(ok) {
			if (!ok) return;
			return callLinks(sid).then(L.bind(function(r) {
				if (r.error)
					ui.addNotification(null, E('p', r.error), 'error');
				else
					this.showLinks(r);
			}, this));
		}, this));
	},

	showLinks: function(r) {
		var body = E('div');
		var entries = r.links.slice();
		if (r.tor) entries.push({ transport: 'tor_key', title: _('Tor key'), key: r.tor });
		var btns = entries.map(function(l, i) {
			return E('button', { 'class': 'btn cbi-button', 'style': 'margin-right:.5em', 'data-transport': l.transport, 'click': function() { pick(i); } }, l.title);
		});
		var linkView = function(l) {
			if (l.error)
				return [ E('p', { 'style': 'color:' + COLOR.dim }, span(COLOR.bad, _('No link for this transport: %s.').format(l.error))) ];
			var ta = E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 5, 'readonly': 'readonly' }, l.link);
			return [
				E('p', { 'style': 'color:' + COLOR.dim }, l.note || ''),
				ta,
				E('div', { 'style': 'margin:.5em 0' }, E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': function() { return copyText(ta.value); } }, _('Copy link'))),
				qrNode(l.link)
			];
		};
		/* what the old Tor page showed under "Key": the onion address and the key for Tor Browser, a tor daemon or the Client page */
		var keyView = function(k) {
			if (k.error)
				return [ E('p', {}, span(COLOR.bad, _('No Tor key: %s.').format(k.error))) ];
			var dir = '/var/lib/tor/onion_auth', al = k.aliases || [], name = al.length ? al[0] + '.onion' : k.onion;
			var torrc = [ 'ClientOnionAuthDir ' + dir ].concat(al.map(function(a) { return 'MapAddress ' + a + '.onion ' + k.onion; })).join('\n');
			var area = function(text, rows) { return E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': rows, 'readonly': 'readonly' }, text); };
			var line = area(k.auth_line, 2), conf = area(torrc, al.length + 1);
			return [
				E('p', _('The onion address of this router and the profile\'s key, the line the Client page of another router takes ("Onion service key"):')),
				line,
				E('div', { 'style': 'margin:.5em 0' }, [
					E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': function() { return copyText(line.value); } }, _('Copy the line')), ' ',
					E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(k.key); } }, _('Copy the key')), ' ',
					E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(conf.value); } }, _('Copy the torrc lines'))
				]),
				E('p', _('Tor Browser: open the address with the port (for example http://%s:%s/) and paste the key when it asks for one.').format(k.onion, (k.ports || [])[0] || 80)),
				E('p', _('A tor daemon on a computer or server (Orbot, a tor client in front of an Xray or SSH client): these lines in its torrc%s, and the line above in the file "%s/%s.auth_private":').format(
					al.length ? ' ' + _('(MapAddress: the client opens %s instead of the address)').format(al.map(function(a) { return a + '.onion'; }).join(', ')) : '', dir, r.name.replace(/[^A-Za-z0-9._-]/g, '_'))),
				conf,
				E('p', { 'style': 'color:' + COLOR.dim }, k.vision_port
					? _('Ports of this router through %s: %s; the Xray server answers on %s:%s too (the links through Tor).').format(name, (k.ports || []).join(', '), name, k.vision_port)
					: _('Ports of this router through %s: %s.').format(name, (k.ports || []).join(', '))),
				qrNode(k.auth_line)
			];
		};
		var pick = function(i) {
			var l = entries[i];
			btns.forEach(function(b, j) { b.className = 'btn cbi-button' + (j == i ? ' cbi-button-action' : ''); });
			dom.content(body, l.key ? keyView(l.key) : linkView(l));
		};
		/* every link and the Tor key, one per line: "All links at once" of a profile on the Client page of another router takes them */
		var all = r.links.filter(function(l) { return l.link; }).map(function(l) { return l.link; });
		if (r.tor && r.tor.auth_line) all.push(r.tor.auth_line);
		ui.showModal(_('Client links') + ' » ' + r.name, [
			E('p', [
				r.host ? _('One link per enabled transport, for the address %s.').format(r.host) + ' ' : '',
				r.onion ? _('The links through Tor go to the onion address %s; a client needs the profile\'s Tor key too ("Tor key").').format(r.onion) + ' ' : '',
				_('Import a link or scan its QR code in the client app.')
			].join('')),
			E('div', { 'style': 'margin-bottom:.5em' }, btns.concat(all.length > 1 ? [
				E('button', { 'class': 'btn cbi-button', 'title': _('Every link and the Tor key, for "All links at once" of a profile on the Client page of another router'),
				              'click': function() { return copyText(all.join('\n') + '\n'); } }, _('Copy all'))
			] : [])),
			body,
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
		]);
		pick(0);
	},

	showLog: function(ev) {
		return common.showLog(callLog, _('Xray log'));
	},

	showConfig: function(ev) {
		return common.showConfig(callConfig, _('Generated configuration'), _('There is no configuration file: the server is off or the settings have not been applied yet.'));
	},

	handleRestart: function(ev) {
		return common.restarted(callRestart, _('Xray restarted; client connections reconnect by themselves.')).then(L.bind(this.refresh, this));
	},

	handleUpdateBridges: function(ev) {
		var self = this, before = (this.tor.bridges_info || {}).state, t0 = Date.now();
		return callTorUpdateBridges().then(function(r) {
			if (r.error) { ui.addNotification(null, E('p', r.error), 'error'); return; }
			var wait = function() {
				return L.resolveDefault(callTorStatus(), null).then(function(st) {
					if (st) { self.tor = st; var el = document.getElementById('tsv-tor-bridges'); if (el) dom.content(el, self.torBridges()); }
					var b = st ? (st.bridges_info || {}) : {};
					var done = b.state && (!before || b.state.time != before.time) && !b.running;
					if (!done && Date.now() - t0 < 120000) return new Promise(function(res) { window.setTimeout(res, 3000); }).then(wait);
					if (!done) { ui.addNotification(null, E('p', _('The update did not finish within two minutes; see the log.')), 'warning'); return; }
					var s = b.state;
					if (s.error) ui.addNotification(null, E('p', _('Bridge update failed: %s').format(s.error)), 'error');
					else ui.addTimeLimitedNotification(null, E('p', !s.changed ? _('The bridge list is up to date (%d lines).').format(s.lines)
						: s.applied ? _('The bridge list changed (%d lines); tor restarts with it.').format(s.lines)
						: _('The bridge list changed (%d lines); tor is connected and keeps its bridges, the new list is used at its next start.').format(s.lines)), 8000, 'info');
				});
			};
			return wait();
		});
	},

	showTorLog: function(ev) {
		return common.showLog(callTorLog, _('tor log'));
	},

	showTorConfig: function(ev) {
		return callTorConfig().then(function(r) {
			common.textModal(_('Generated tor configuration'), r.config || _('There is no configuration file: tor is not needed or the settings have not been applied yet.'),
				E('p', { 'style': 'color:' + COLOR.dim }, (r.path || '') + ((r.clients || []).length ? ' — ' + _('authorized clients: %s').format(r.clients.join(', ')) : '')));
		});
	},

	handleTorRestart: function(ev) {
		return common.restarted(callTorRestart, _('tor restarted; it connects to the Tor network again, which takes a minute.')).then(L.bind(this.refresh, this));
	},

	/* the Tor key of a profile (section: the dialog's own section: LuCI renders a dialog as a separate map) */
	newTorKey: function(section, section_id) {
		return callTorKeypair().then(L.bind(function(r) {
			if (r.error) {
				ui.addNotification(null, E('p', r.error), 'error');
				return;
			}
			var el = section.getUIElement(section_id, 'tor_key');
			el.setValue(r.private_key);
			el.triggerValidation();
			this.showTorPublicKey(section_id, r.private_key, r.public_key);
		}, this));
	},

	showTorPublicKey: function(section_id, priv, pub) {
		this.torPublicKeyFor[priv] = pub;
		var cell = document.getElementById('tsv-torpub-' + section_id);
		if (!cell) return;
		dom.content(cell, pub ? E('code', { 'style': 'user-select:all; word-break:break-all' }, pub)
		                      : span(COLOR.dim, _('— enter a valid key —')));
	},

	updateTorPublicKey: function(section_id, priv) {
		priv = String(priv || '').trim();
		if (this.torPublicKeyFor[priv] !== undefined)
			return this.showTorPublicKey(section_id, priv, this.torPublicKeyFor[priv]);
		if (!/^[A-Z2-7]{52}$/.test(priv))
			return this.showTorPublicKey(section_id, priv, '');
		return callTorPubkey(priv).then(L.bind(function(r) {
			this.showTorPublicKey(section_id, priv, r.public_key || '');
		}, this));
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var st = this.status;
		var site = st.site || null;
		var domains = st.domains || [];
		var m, s, o;

		m = new form.Map(CFG, _('Server'),
			_('An xray server with the transports below (VLESS + REALITY over TCP with XTLS-Vision and over XHTTP, Hysteria2) and the onion service of the router\'s tor; every profile is a user with a link per transport. Nothing changes on the router until "Save & Apply" or the button that turns the server on or off.'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));

		o = s.option(form.DummyValue, '_ov_server', _('Server'),
			_('The button saves and applies the page like "Save & Apply". On: xray starts with the settings below and the ports of the enabled transports are opened from the Internet (firewall rules "xtunnel-server: …"). Off: xray stops and the ports are closed.'));
		o.renderWidget = function() {
			return E('div', {}, [ E('div', { 'id': 'tsv-ov-server' }, self.overviewServer()), E('div', { 'style': 'margin-top:.5em' }, common.switchButton(self, CFG, 'enabled', _('Turn the server on'), _('Turn the server off'))) ]);
		};

		/* while the server is off only what is still in effect is shown */
		var on = function() { return !!self.status.enabled; };
		common.statusRow(s, '_ov_access', _('Access from the Internet'), L.bind(this.overviewAccess, this), function() { return on() || self.openPorts().length > 0; });
		common.statusRow(s, '_ov_cert', _('Certificate'), L.bind(this.overviewCert, this), function() { return on() && !!self.status.cert; });
		common.statusRow(s, '_ov_config', _('Configuration'), L.bind(this.overviewConfig, this), function() { return on() || !!self.status.error; });

		o = common.shownWhile(s.option(form.DummyValue, '_tools', _('Tools')), '_tools', on);
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showLog') }, _('Show log')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showConfig') }, _('Show configuration')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleRestart') }, _('Restart Xray'))
			]);
		};

		/* Profiles */
		s = m.section(form.GridSection, 'profile', _('Profiles'),
			_('Every profile (a person or a device) has a UUID for the VLESS transports, a password for Hysteria2 and a key for the onion service, and works on every enabled transport. "Links" gives a link and a QR code per transport, the links through Tor and the Tor key.'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add profile…');
		s.modaltitle = function(sid) {
			return _('Profile') + ' » ' + (uci.get(CFG, sid, 'name') || _('new profile'));
		};

		/* a new profile gets a Tor key pair from the router */
		common.saveBeforeModal(s, function() {
			return L.resolveDefault(callTorKeypair(), {}).then(function(r) {
				self.pendingTorKey = (r && r.private_key) ? r : null;
			});
		});

		s.renderRowActions = function(section_id) {
			var tdEl = this.super('renderRowActions', [ section_id, _('Edit') ]);
			var existing = [].slice.call(tdEl.lastChild.childNodes);
			dom.content(tdEl.lastChild, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'title': _('The links and QR codes for the client app'),
					'click': ui.createHandlerFn(self, 'handleLinks', section_id)
				}, _('Links')), ' '
			].concat(existing));
			return tdEl;
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'), _('Switch off to lock this profile out without deleting it.'));
		o.rmempty = false;
		o.default = '1';
		o.editable = true;

		o = s.option(form.Value, 'name', _('Name'), _('Who or which device this is; it appears in the links and in the log.'));
		o.rmempty = false;
		o.placeholder = _('phone');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v || v.length > 64) return _('1 to 64 characters');
			var dup = false;
			uci.sections(CFG, 'profile', function(c) {
				if (c['.name'] != section_id && String(c.name || '').toLowerCase() == v.toLowerCase()) dup = true;
			});
			return dup ? _('Another profile has this name') : true;
		};

		o = s.option(form.Value, 'uuid', 'UUID', _('The profile\'s identifier on the VLESS transports. A random one is filled in for a new profile.'));
		o.modalonly = true;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim())
				? true : _('Enter a UUID, for example 123e4567-e89b-42d3-a456-426614174000');
		};
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			return form.Value.prototype.renderWidget.call(this, section_id, option_index, (cfgvalue != null) ? cfgvalue : randomUUID());
		};

		o = s.option(form.Button, '_uuid', _('New UUID'), _('Replaces the UUID; the VLESS links of the profile have to be exported again.'));
		o.modalonly = true;
		o.inputtitle = _('Generate');
		o.onclick = function(ev, section_id) {
			var el = this.section.getUIElement(section_id, 'uuid');
			el.setValue(randomUUID());
			el.triggerValidation();
		};

		o = s.option(form.Value, 'password', _('Hysteria2 password'), _('The profile\'s password on the Hysteria2 transport. A random one is filled in for a new profile.'));
		o.modalonly = true;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			var v = String(value || '');
			if (v.length < 8 || v.length > 64) return _('8 to 64 characters');
			if (/\s/.test(v)) return _('No spaces');
			return true;
		};
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			return form.Value.prototype.renderWidget.call(this, section_id, option_index, (cfgvalue != null) ? cfgvalue : randomPassword(22));
		};

		o = s.option(form.Button, '_password', _('New password'), _('Replaces the Hysteria2 password; the Hysteria2 link of the profile has to be exported again.'));
		o.modalonly = true;
		o.inputtitle = _('Generate');
		o.onclick = function(ev, section_id) {
			var el = this.section.getUIElement(section_id, 'password');
			el.setValue(randomPassword(22));
			el.triggerValidation();
		};

		o = s.option(form.DummyValue, '_tor_state', _('Tor'));
		o.modalonly = false;
		o.editable = true;                         /* rendered through renderWidget in the table */
		o.renderWidget = function(section_id) {
			return E('span', { 'id': 'tsv-tor-profile-' + section_id }, self.torProfileState(section_id));
		};

		o = s.option(form.Value, 'tor_key', _('Tor key'),
			_('The profile\'s key for the onion service: an x25519 key, base32 (52 characters). A new pair is generated on the router for a new profile; the router keeps only what it needs (the public key goes into the service), the key is what the client enters. Empty: the profile has no access through the onion address.'));
		o.modalonly = true;
		o.rmempty = true;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			self.updateTorPublicKey(section_id, v);
			return (!v || /^[A-Z2-7]{52}$/.test(v)) ? true : _('52 characters of base32: A–Z and 2–7');
		};
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			var value = cfgvalue;
			if (value == null && self.pendingTorKey) {
				value = self.pendingTorKey.private_key;
				self.torPublicKeyFor[value] = self.pendingTorKey.public_key;
				self.pendingTorKey = null;
			}
			var node = form.Value.prototype.renderWidget.call(this, section_id, option_index, value);
			window.setTimeout(function() { self.updateTorPublicKey(section_id, value); }, 0);
			return node;
		};

		o = s.option(form.DummyValue, '_tor_public', _('Tor public key'), _('Derived from the Tor key; this is what the onion service stores as the profile\'s authorization.'));
		o.modalonly = true;
		o.renderWidget = function(section_id) {
			return E('span', { 'id': 'tsv-torpub-' + section_id }, span(COLOR.dim, '…'));
		};

		o = s.option(form.Button, '_tor_newkey', _('New Tor key'), _('Replaces the Tor key; the client has to get the new key.'));
		o.modalonly = true;
		o.inputtitle = _('Generate');
		o.onclick = function(ev, section_id) {
			return self.newTorKey(this.section, section_id);
		};

		/* REALITY */
		s = m.section(form.NamedSection, 'main', CFG, _('REALITY'),
			_('Settings of the two VLESS transports. Connections without a valid client key are forwarded to the target, a site that answers over TLS 1.3; the server names are the names on its certificate.'));
		this.realitySection = s;

		var targetDesc = _('Address and port that connections without a client key are forwarded to; the certificate there must match the server names. "127.0.0.1:443" is this router\'s own HTTPS site (XTunnel → Dynamic DNS): when a TCP transport of this server runs on that port itself, the site is served behind it on 127.0.0.1:4443 and the target follows. A public site that answers over TLS 1.3, for example "www.samsung.com:443", works too.');
		if (site && site.enabled && site.hostname)
			targetDesc += ' ' + _('The router currently serves the site for %s on port %s.').format(site.hostname, site.port);
		o = s.option(form.Value, 'target', _('Target'), targetDesc);
		o.placeholder = '127.0.0.1:443';
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			return (!v || /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):[0-9]{1,5}$/.test(v))
				? true : _('Enter host:port, for example 127.0.0.1:443');
		};

		o = s.option(form.DynamicList, 'server_name', _('Server names'),
			_('Names on the target\'s certificate, one per entry; for the router\'s own site its domain. Clients send the first one.'));
		o.datatype = 'hostname';
		o.placeholder = (site && site.hostname) ? site.hostname : 'www.example.com';

		o = s.option(form.Value, 'private_key', _('Private key'),
			_('The REALITY private key (X25519); its public key goes into the VLESS links. "Generate keypair" makes a new pair: after "Save & Apply" the VLESS links of the profiles stop working until they are exported again.'));
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			return (!v || KEY_RE.test(v)) ? true : _('43 characters: letters, digits, "-" and "_"');
		};
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			var node = form.Value.prototype.renderWidget.apply(this, arguments);
			var input = node.querySelector ? node.querySelector('input') : null, timer = null;
			if (input)
				input.addEventListener('input', function() {
					window.clearTimeout(timer);
					timer = window.setTimeout(function() { self.updatePublicKey(input.value); }, 400);
				});
			return withButtons(node, [ button(_('Generate keypair'), L.bind(self.handleKeypair, self)) ]);
		};

		o = s.option(form.DummyValue, '_public_key', _('Public key'),
			_('Derived from the private key; clients get it in their links.'));
		o.renderWidget = function() {
			self.pubkeyNode = E('span', { 'id': 'tsv-pubkey' });
			var cur = String(uci.get(CFG, 'main', 'private_key') || '').trim();
			if (cur === self.publicKeyFor)
				self.showPublicKey(self.publicKey, self.publicKeyNote, cur);
			else
				self.updatePublicKey(cur);
			return self.pubkeyNode;
		};

		o = s.option(form.DynamicList, 'short_id', _('Short IDs'),
			_('Hexadecimal, 2 to 16 characters (an even count). Clients send the first one.'));
		o.validate = function(section_id, value) {
			var list = Array.isArray(value) ? value : [ value ];
			for (var i = 0; i < list.length; i++)
				if (list[i] != null && list[i] !== '' && !/^([0-9a-f]{2}){1,8}$/.test(String(list[i]).trim()))
					return _('2 to 16 hexadecimal characters (0-9, a-f), an even count');
			return true;
		};
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			var node = form.DynamicList.prototype.renderWidget.apply(this, arguments);
			return E('div', {}, [ node, E('div', { 'style': 'margin-top:.3em' }, button(_('Add a random short ID'), L.bind(self.handleAddShortId, self))) ]);
		};

		/* Transports */
		s = m.section(form.NamedSection, 'main', CFG, _('Transports'),
			_('Every transport has its own port; the port is opened from the Internet while the server runs. Every profile works on every enabled transport.'));
		this.transportSection = s;
		s.tab('vision', _('TCP + XTLS-Vision'));
		s.tab('xhttp', _('XHTTP'));
		s.tab('hysteria2', _('Hysteria2'));

		o = s.taboption('vision', form.Flag, 'vision_enabled', _('Enabled'),
			_('VLESS + REALITY over TCP with XTLS-Vision, supported by every current client app.'));
		o.rmempty = false;

		o = s.taboption('vision', form.Value, 'vision_port', _('TCP port'), _('On 443 the server sits in front of the router\'s own site: the site of the Dynamic DNS page is then served behind the server on 127.0.0.1:4443, and connections without a client key are forwarded to it.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.default = '443';
		o.placeholder = '443';
		o.depends('vision_enabled', '1');

		o = s.taboption('vision', form.Value, 'vision_link_port', _('Port in client links'),
			_('Only when a router in front forwards a different public port to this one. Empty: the port above.'));
		o.datatype = 'port';
		o.placeholder = _('same as the port');
		o.depends('vision_enabled', '1');

		o = s.taboption('xhttp', form.Flag, 'xhttp_enabled', _('Enabled'),
			_('VLESS + REALITY over XHTTP (HTTP requests and responses); needs a client app with the Xray core.'));
		o.rmempty = false;

		o = s.taboption('xhttp', form.Value, 'xhttp_port', _('TCP port'), _('Another TCP port than the one of TCP + XTLS-Vision.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.default = '8443';
		o.placeholder = '8443';
		o.depends('xhttp_enabled', '1');

		o = s.taboption('xhttp', form.Value, 'xhttp_path', _('Path'),
			_('The HTTP path of the XHTTP requests, starting with "/".'));
		o.rmempty = false;
		o.default = '/' + randomHex(4);
		o.depends('xhttp_enabled', '1');
		o.validate = function(section_id, value) {
			return /^\/[A-Za-z0-9._~\/-]*$/.test(String(value || '').trim())
				? true : _('Start with "/" and use letters, digits, ".", "_", "-" and "/"');
		};
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			return withButtons(form.Value.prototype.renderWidget.apply(this, arguments),
				[ button(_('Set a random path'), function() { self.setTransportValue('xhttp_path', '/' + randomHex(4)); }) ]);
		};

		o = s.taboption('xhttp', form.ListValue, 'xhttp_mode', _('Mode'), _('"auto" suits every client.'));
		XHTTP_MODES.forEach(function(v) { o.value(v, v); });
		o.default = 'auto';
		o.depends('xhttp_enabled', '1');

		o = s.taboption('xhttp', form.Value, 'xhttp_link_port', _('Port in client links'),
			_('Only when a router in front forwards a different public port to this one. Empty: the port above.'));
		o.datatype = 'port';
		o.placeholder = _('same as the port');
		o.depends('xhttp_enabled', '1');

		o = s.taboption('hysteria2', form.Flag, 'hysteria2_enabled', _('Enabled'),
			_('Hysteria2 over QUIC (UDP) with an ordinary TLS certificate for the name clients connect to; the easiest source is a domain from the Dynamic DNS page.'));
		o.rmempty = false;

		o = s.taboption('hysteria2', form.Value, 'hysteria2_port', _('UDP port'), _('UDP and TCP ports are separate: 443 works next to TCP + XTLS-Vision on 443.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.default = '443';
		o.placeholder = '443';
		o.depends('hysteria2_enabled', '1');

		o = s.taboption('hysteria2', form.Value, 'hysteria2_link_port', _('Port in client links'),
			_('Only when a router in front forwards a different public UDP port to this one. Empty: the port above.'));
		o.datatype = 'port';
		o.placeholder = _('same as the port');
		o.depends('hysteria2_enabled', '1');

		o = s.taboption('hysteria2', form.ListValue, 'cert_source', _('Certificate'),
			_('Where the TLS certificate of the Hysteria2 transport comes from. xray reads the files again every hour, so renewals need no restart.'));
		o.value('ddns', _('A domain from the Dynamic DNS page'));
		o.value('files', _('Certificate files on the router'));
		o.default = 'ddns';
		o.depends('hysteria2_enabled', '1');

		o = s.taboption('hysteria2', form.ListValue, 'cert_domain', _('Domain'),
			_('The Hysteria2 transport answers to this name with its Let\'s Encrypt certificate from the Dynamic DNS page; the name goes into the links.'));
		if (!domains.length)
			o.value('', _('(no domain on the Dynamic DNS page yet)'));
		domains.forEach(function(d) {
			var n = daysLeft(d.expires);
			o.value(d.id, d.hostname + (d.has_cert ? (n != null ? ' (' + _('certificate: %d days left').format(n) + ')' : '') : ' (' + _('no certificate yet') + ')'));
		});
		o.depends({ hysteria2_enabled: '1', cert_source: 'ddns' });

		o = s.taboption('hysteria2', form.Value, 'cert_name', _('TLS server name'),
			_('The name on the certificate; clients send it as the SNI.'));
		o.datatype = 'hostname';
		o.rmempty = false;
		o.depends({ hysteria2_enabled: '1', cert_source: 'files' });

		o = s.taboption('hysteria2', form.Value, 'cert_path', _('Certificate file'), _('PEM, the full chain.'));
		o.rmempty = false;
		o.placeholder = '/etc/ssl/certs/example.pem';
		o.depends({ hysteria2_enabled: '1', cert_source: 'files' });
		o.validate = function(section_id, value) {
			return /^\/\S+$/.test(String(value || '').trim()) ? true : _('Enter an absolute path');
		};

		o = s.taboption('hysteria2', form.Value, 'key_path', _('Private key file'), _('PEM.'));
		o.rmempty = false;
		o.placeholder = '/etc/ssl/private/example.key';
		o.depends({ hysteria2_enabled: '1', cert_source: 'files' });
		o.validate = function(section_id, value) {
			return /^\/\S+$/.test(String(value || '').trim()) ? true : _('Enter an absolute path');
		};

		o = s.taboption('hysteria2', form.Value, 'hysteria2_obfs', _('Obfuscation password'),
			_('Optional. Salamander obfuscation of the QUIC packets; every client uses the same password (it goes into the links). Empty: off.'));
		o.rmempty = true;
		o.placeholder = _('empty = off');
		o.depends('hysteria2_enabled', '1');
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			return withButtons(form.Value.prototype.renderWidget.apply(this, arguments), [
				button(_('Random password'), function() { self.setTransportValue('hysteria2_obfs', randomPassword(16)); }),
				button(_('Clear'), function() { self.setTransportValue('hysteria2_obfs', ''); })
			]);
		};

		o = s.taboption('hysteria2', form.Value, 'hysteria2_masquerade', _('Masquerade'),
			_('What an HTTP/3 request without a profile password gets: a URL to proxy (http:// or https://, for example https://127.0.0.1:443 for this router\'s own site), a directory to serve (/path), or an xray masquerade object in JSON. Empty: a 404 answer.'));
		o.rmempty = true;
		o.placeholder = _('empty = 404');
		o.depends('hysteria2_enabled', '1');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v) return true;
			if (v.charAt(0) == '{') {
				try { return (typeof JSON.parse(v) == 'object') ? true : _('Not a valid JSON object'); } catch (e) { return _('Not a valid JSON object'); }
			}
			return /^(https?:\/\/\S+|(file:\/\/)?\/\S*)$/.test(v) ? true : _('Enter an http:// or https:// URL, a directory starting with "/", or a JSON object');
		};

		/* a transport switched off keeps its settings (LuCI removes options hidden by depends on save) */
		s.children.forEach(function(c) { c.retain = true; });

		/* Clients */
		s = m.section(form.NamedSection, 'main', CFG, _('Clients'));

		o = s.option(form.Value, 'link_host', _('Address in the links'),
			(site && site.hostname)
				? _('The public DNS name or IP address of this router that clients connect to. Empty: %s, the domain of the web site from the Dynamic DNS page.').format(site.hostname)
				: _('The public DNS name or IP address of this router that clients connect to, for example a domain from the Dynamic DNS page. Empty: the TLS server name of the Hysteria2 certificate.'));
		o.datatype = 'host';
		o.rmempty = true;
		o.placeholder = (site && site.hostname) ? site.hostname : 'router.example.org';

		o = s.option(form.Flag, 'local_access', _('Access to local networks'),
			_('Clients may reach the router itself and the networks behind it (LAN, the router in front) through the server. Off: only the Internet; private addresses are blocked.'));
		o.rmempty = false;
		o.default = '1';

		/* Tor: the onion service and the router's connection to the Tor network (also for the client's links through Tor) */
		s = m.section(form.NamedSection, 'tor', 'tor', _('Tor'));
		s.tab('onion', _('Onion service'),
			_('This router as an onion service: an address in the Tor network that reaches the router\'s own ports (SSH, the web interface, the Xray server) from anywhere, without a public IP address, open ports or a domain. Only the profiles with a Tor key can use it. No firewall port is opened: the router makes the connections itself. The onion address is created on the first start and kept in /etc/tor/xtunnel-tor.'));
		s.tab('connection', _('Connection to the Tor network'),
			_('The router\'s tor connects to the Tor network itself; where direct connections to Tor are blocked, it goes through bridges. It runs while the onion service is on or the Client page uses links through Tor, and these settings apply to both.'));


		o = s.taboption('onion', form.DummyValue, '_tor_address', _('Onion address'));
		o.renderWidget = function() { return E('span', { 'id': 'tsv-tor-address' }, self.torAddress()); };

		o = s.taboption('onion', form.Flag, 'enabled', _('Run the onion service'),
			_('Starts tor (if it does not run for the Client page already) with the onion service. Switch off to stop the service; tor goes too when nothing else needs it.'));
		o.rmempty = false;

		o = s.taboption('onion', form.DynamicList, 'port', _('Ports'),
			_('Ports of this router reachable through the onion address, each to the same port on the router itself: 22 is SSH, 80 the web interface (or the site), 443 the site over HTTPS and the Xray server in front of it, 8443 the XHTTP transport; the VLESS transports whose port is here get links through Tor.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v) return true;
			return /^\d{1,5}$/.test(v) && parseInt(v, 10) >= 1 && parseInt(v, 10) <= 65535 ? true : _('Enter a port number');
		};

		o = s.taboption('onion', form.DynamicList, 'alias', _('Names for clients'),
			_('Names under which a tor client opens this router, for example "router-home": the client maps NAME.onion to the onion address with a MapAddress line in its torrc. "Tor key" in the links of a profile shows the lines. Letters, digits, dashes and underscores; the router\'s own tor does not use them.'));
		o.rmempty = true;
		o.placeholder = 'router-home';
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v) return true;
			return /^[A-Za-z0-9_-]{1,63}$/.test(v) ? true : _('1 to 63 characters: letters, digits, dashes, underscores (without ".onion")');
		};


		o = s.taboption('connection', form.DummyValue, '_tor_service', _('State'));
		o.renderWidget = function() { return E('span', { 'id': 'tsv-tor-service' }, self.torService()); };

		o = s.taboption('connection', form.DummyValue, '_tor_bridges', _('Bridges in use'));
		o.renderWidget = function() { return E('span', { 'id': 'tsv-tor-bridges' }, self.torBridges()); };

		o = s.taboption('connection', form.DummyValue, '_tor_config', _('Configuration'));
		o.renderWidget = function() { return E('span', { 'id': 'tsv-tor-config' }, self.torConfig()); };

		o = s.taboption('connection', form.DummyValue, '_tor_tools', _('Tools'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showTorLog') }, _('Show tor log')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showTorConfig') }, _('Show tor configuration')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleTorRestart') }, _('Restart tor'))
			]);
		};

		o = s.taboption('connection', form.ListValue, 'bridges', _('Bridges'),
			_('How tor reaches the Tor network. Built-in: the list shipped with the package (obfs4, webtunnel and snowflake bridges), refreshed from bridges.torproject.org when a country is set below.'));
		o.value('builtin', _('Built-in bridges'));
		o.value('custom', _('Bridges entered below'));
		o.value('none', _('None: connect directly'));
		o.default = 'builtin';

		o = s.taboption('connection', form.ListValue, 'snowflake', _('Snowflake bridges'),
			_('Snowflake reaches the Tor network through volunteer proxies found by a broker and keeps trying new proxies, which costs traffic. As the fallback the snowflake lines are added only when tor had no working circuit through the other bridges for 6 minutes while the router has a default route, and held back again after 30 minutes of circuits through the other bridges, 24 hours after they were added, or when the daily bridge update brings a changed list. Checked every 2 minutes through tor\'s control port on 127.0.0.1; every change restarts tor.'));
		o.value('fallback', _('Only when no other bridge works'));
		o.value('always', _('Always'));
		o.value('never', _('Never'));
		o.default = 'fallback';
		o.retain = true;
		o.depends('bridges', 'builtin');
		o.depends('bridges', 'custom');

		o = s.taboption('connection', form.Value, 'bridge_country', _('Country for bridges'),
			_('Two-letter country code (ISO 3166-1). Once a day, and with "Update bridges" above, the router asks bridges.torproject.org for the bridges Tor Browser hands out in that country, through its own Tor connection, and adds them to the built-in list (newest first, up to 12 per transport). Empty: the list shipped with the package, never refreshed.'));
		o.depends('bridges', 'builtin');
		o.retain = true;
		o.rmempty = true;
		o.placeholder = _('empty = no updates');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			return (!v || /^[A-Za-z]{2}$/.test(v)) ? true : _('Two letters');
		};

		o = s.taboption('connection', form.DynamicList, 'bridge', _('Bridge lines'),
			_('One bridge per entry, as given by bridges.torproject.org or Telegram @GetBridgesBot, with or without the leading "Bridge": for example "obfs4 192.0.2.1:443 FINGERPRINT cert=… iat-mode=0".'));
		o.depends('bridges', 'custom');
		o.retain = true;
		o.rmempty = true;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim().replace(/^Bridge\s+/, '');
			if (!v) return true;
			if (/^(obfs4|snowflake|meek_lite|webtunnel) \S+:\d+ [0-9A-Fa-f]{40}( \S+)*$/.test(v) || /^\S+:\d+ [0-9A-Fa-f]{40}$/.test(v)) return true;
			return _('Expected "transport address:port fingerprint …" or "address:port fingerprint"');
		};

		o = s.taboption('connection', form.Flag, 'persistent_cache', _('Keep tor\'s cache on the router\'s storage'),
			_('tor\'s data directory (about 33 MB, mostly the relay descriptors) in /etc/tor/xtunnel-tor-data instead of /var/lib/tor in the memory, so that tor does not download the directory again after a restart of the router (about 17 MB each time). Needs that much free space on the router\'s storage; tor rewrites the consensus there every few hours (about 3 MB). The cache moves along when the option is switched on or off, and only one copy is kept.'));
		o.rmempty = false;
		o.default = '0';

		o = s.taboption('connection', form.Flag, 'reduced_padding', _('Less padding traffic'),
			_('ReducedConnectionPadding and ReducedCircuitPadding: tor closes idle connections to relays sooner, sends less padding on its connections and uses only the circuit padding machines with a low overhead. The tor manual offers these options for clients on links where traffic is expensive.'));
		o.rmempty = false;
		o.default = '0';

		this.publicKey = st.public_key || '';
		this.publicKeyNote = '';
		this.publicKeyFor = String(uci.get(CFG, 'main', 'private_key') || '').trim();

		return m.render().then(L.bind(function(nodes) {
			if (!st.public_key)
				this.updatePublicKey(this.publicKeyFor);
			poll.add(L.bind(this.refresh, this), 5);
			return nodes;
		}, this));
	}
});
