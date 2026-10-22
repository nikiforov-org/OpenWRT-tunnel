'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require uqr';

var CFG = 'tunnel-server';

var callStatus  = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callKeypair = rpc.declare({ object: CFG, method: 'keypair', expect: {} });
var callPubkey  = rpc.declare({ object: CFG, method: 'pubkey', params: [ 'private_key' ], expect: {} });
var callLinks   = rpc.declare({ object: CFG, method: 'links', params: [ 'profile' ], expect: {} });
var callLog     = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callConfig  = rpc.declare({ object: CFG, method: 'config', expect: {} });
var callRestart = rpc.declare({ object: CFG, method: 'restart', expect: {} });

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };
var XHTTP_MODES = [ 'auto', 'packet-up', 'stream-up', 'stream-one' ];
var TRANSPORT = { vision: 'TCP + Vision', xhttp: 'XHTTP', hysteria2: 'Hysteria2' };
var PROTO = { vision: 'tcp', xhttp: 'tcp', hysteria2: 'udp' };
var KEY_RE = /^[A-Za-z0-9_-]{43}$/;
var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function span(color, text) {
	return E('span', { 'style': color ? 'color:' + color : '' }, text);
}

function timeAgo(ts) {
	if (!ts) return '';
	var s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
	if (s < 90)       return _('%d seconds ago').format(s);
	if (s < 5400)     return _('%d minutes ago').format(Math.round(s / 60));
	if (s < 172800)   return _('%d hours ago').format(Math.round(s / 3600));
	return _('%d days ago').format(Math.round(s / 86400));
}

function daysLeft(expires) {
	return expires ? Math.floor((expires * 1000 - Date.now()) / 86400000) : null;
}

function hex(bytes) {
	return Array.from(bytes, function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

function randomHex(n) {
	return hex(crypto.getRandomValues(new Uint8Array(n)));
}

function randomUUID() {
	var b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	var h = hex(b);
	return h.substr(0, 8) + '-' + h.substr(8, 4) + '-' + h.substr(12, 4) + '-' + h.substr(16, 4) + '-' + h.substr(20);
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

function copyText(text) {
	var p = (navigator.clipboard && navigator.clipboard.writeText)
		? navigator.clipboard.writeText(text) : Promise.reject(new Error('clipboard unavailable'));
	return p.then(function() {
		ui.addTimeLimitedNotification(null, E('p', _('Copied to the clipboard.')), 4000, 'info');
	}).catch(function() {
		var ta = E('textarea', { 'style': 'position:fixed;top:0;left:0;opacity:0' }, text);
		document.body.appendChild(ta);
		ta.select();
		var ok = false;
		try { ok = document.execCommand('copy'); } catch (e) {}
		document.body.removeChild(ta);
		ui.addTimeLimitedNotification(null, E('p', ok ? _('Copied to the clipboard.') : _('Could not copy; select the text and copy it by hand.')), 4000, ok ? 'info' : 'warning');
	});
}

function textModal(title, text, header) {
	ui.showModal(title, [
		header || '',
		E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 24, 'readonly': 'readonly' }, text),
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
	]);
}

return view.extend({
	status: {},

	load: function() {
		return L.resolveDefault(callStatus(), {}).then(L.bind(function(st) {
			this.status = st || {};
		}, this));
	},

	/* ---------- status cells ---------- */

	overviewServer: function() {
		var st = this.status;
		if (!st.installed)
			return span(COLOR.bad, _('xray-core is not installed on the router. It is a dependency of this package: run "apk update && apk add xray-core".'));
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

	/* the on/off button of the overview: sets "enabled" and runs LuCI's Save & Apply, with the rest of the page */
	switchButton: function() {
		var on = uci.get(CFG, 'main', 'enabled') == '1';
		return E('button', {
			'class': 'btn cbi-button ' + (on ? 'cbi-button-negative' : 'cbi-button-positive'),
			'click': ui.createHandlerFn(this, 'handleSwitch', !on)
		}, on ? _('Turn the server off') : _('Turn the server on'));
	},

	handleSwitch: function(on, ev) {
		uci.set(CFG, 'main', 'enabled', on ? '1' : '0');
		return this.handleSaveApply(ev, '0');
	},

	overviewAccess: function() {
		var fw = this.status.firewall || {}, parts = [];
		for (var k in TRANSPORT)
			if (fw[k]) parts.push(fw[k] + '/' + PROTO[k] + ' (' + TRANSPORT[k] + ')');
		return parts.length
			? span(COLOR.ok, _('Open from the Internet: %s (firewall rules "tunnel-server: …")').format(parts.join(', ')))
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
		if (st.error)
			return span(COLOR.bad, _('Not applied: %s').format(st.error));
		if (!st.enabled)
			return span(COLOR.dim, _('No configuration file while the server is off'));
		if (st.config_time)
			return span(COLOR.ok, _('Written %s to /etc/tunnel-server/config.json').format(timeAgo(st.config_time)));
		return span(COLOR.warn, _('Not written yet'));
	},

	refresh: function() {
		return L.resolveDefault(callStatus(), null).then(L.bind(function(st) {
			if (!st) return;
			this.status = st;
			var el;
			if ((el = document.getElementById('tsv-ov-server'))) dom.content(el, this.overviewServer());
			if ((el = document.getElementById('tsv-ov-access'))) dom.content(el, this.overviewAccess());
			if ((el = document.getElementById('tsv-ov-cert')))   dom.content(el, this.overviewCert());
			if ((el = document.getElementById('tsv-ov-config'))) dom.content(el, this.overviewConfig());
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

	ensureSaved: function() {
		return this.map.save(null, true).then(function() {
			return uci.changes();
		}).then(function(changes) {
			var n = 0;
			for (var c in (changes || {})) n += changes[c].length;
			if (n > 0) {
				ui.addNotification(null, E('p', _('There are unsaved changes. Click "Save & Apply" at the bottom of the page first, then try again.')), 'warning');
				return false;
			}
			return true;
		}).catch(function(e) {
			ui.addNotification(null, E('p', String(e.message || e)), 'error');
			return false;
		});
	},

	handleLinks: function(sid, ev) {
		return this.ensureSaved().then(L.bind(function(ok) {
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
		var ta = E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 5, 'readonly': 'readonly' });
		var note = E('p', { 'style': 'color:' + COLOR.dim });
		var qr = E('div', { 'style': 'margin:1em auto; width:240px' });
		var copy = E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': function() { return copyText(ta.value); } }, _('Copy link'));
		var btns = r.links.map(function(l, i) {
			return E('button', { 'class': 'btn cbi-button', 'style': 'margin-right:.5em', 'data-transport': l.transport, 'click': function() { pick(i); } }, l.title);
		});
		var pick = function(i) {
			var l = r.links[i], svg = null;
			btns.forEach(function(b, j) { b.className = 'btn cbi-button' + (j == i ? ' cbi-button-action' : ''); });
			if (l.error) {
				ta.value = '';
				copy.disabled = true;
				dom.content(note, span(COLOR.bad, _('No link for this transport: %s.').format(l.error)));
				dom.content(qr, '');
				return;
			}
			ta.value = l.link;
			copy.disabled = false;
			dom.content(note, l.note || '');
			try { svg = uqr.renderSVG(l.link, { pixelSize: 4 }); } catch (e) {}
			dom.content(qr, svg ? Object.assign(E(svg), { style: 'width:100%; height:auto' }) : span(COLOR.dim, _('QR code unavailable')));
		};
		ui.showModal(_('Client links') + ' » ' + r.name, [
			E('p', _('One link per enabled transport, for the address %s. Import a link or scan its QR code in the client app.').format(r.host)),
			E('div', { 'style': 'margin-bottom:.5em' }, btns),
			note,
			ta,
			E('div', { 'style': 'margin:.5em 0' }, copy),
			qr,
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
		]);
		pick(0);
	},

	showLog: function(ev) {
		return callLog().then(function(r) {
			textModal(_('Xray log'), r.log || _('The log is empty.'));
		});
	},

	showConfig: function(ev) {
		return callConfig().then(function(r) {
			textModal(_('Generated configuration'), r.config || _('There is no configuration file: the server is off or the settings have not been applied yet.'),
				E('p', { 'style': 'color:' + COLOR.dim }, r.path || ''));
		});
	},

	handleRestart: function(ev) {
		return callRestart().then(L.bind(function(r) {
			if (r.error || !r.ok)
				ui.addNotification(null, E('p', r.error || r.log || _('Restart failed.')), 'error');
			else
				ui.addTimeLimitedNotification(null, E('p', _('Xray restarted; client connections reconnect by themselves.')), 5000, 'info');
			return this.refresh();
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
			_('One xray process on this router serves the enabled transports: VLESS + REALITY over TCP with XTLS-Vision, VLESS + REALITY over XHTTP and Hysteria2 over QUIC (UDP). Devices with a profile\'s links connect to it over the Internet and use the router\'s connection. Nothing changes on the router until you click "Save & Apply" or the button that turns the server on or off.'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));

		o = s.option(form.DummyValue, '_ov_server', _('Server'),
			_('The button saves and applies the page like "Save & Apply". On: xray starts with the settings below and the ports of the enabled transports are opened from the Internet (firewall rules "tunnel-server: …"). Off: xray stops and the ports are closed.'));
		o.renderWidget = function() {
			return E('div', {}, [ E('div', { 'id': 'tsv-ov-server' }, self.overviewServer()), E('div', { 'style': 'margin-top:.5em' }, self.switchButton()) ]);
		};

		o = s.option(form.DummyValue, '_ov_access', _('Access from the Internet'));
		o.renderWidget = function() { return E('span', { 'id': 'tsv-ov-access' }, self.overviewAccess()); };

		o = s.option(form.DummyValue, '_ov_cert', _('Certificate'));
		o.renderWidget = function() { return E('span', { 'id': 'tsv-ov-cert' }, self.overviewCert()); };

		o = s.option(form.DummyValue, '_ov_config', _('Configuration'));
		o.renderWidget = function() { return E('span', { 'id': 'tsv-ov-config' }, self.overviewConfig()); };

		o = s.option(form.DummyValue, '_tools', _('Tools'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showLog') }, _('Show log')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showConfig') }, _('Show configuration')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleRestart') }, _('Restart Xray'))
			]);
		};

		/* Server */
		s = m.section(form.NamedSection, 'main', CFG, _('Server'));

		o = s.option(form.Flag, 'local_access', _('Access to local networks'),
			_('Clients may reach the router itself and the networks behind it (LAN, the router in front) through the server. Off: only the Internet; private addresses are blocked.'));
		o.rmempty = false;
		o.default = '1';

		/* REALITY */
		s = m.section(form.NamedSection, 'main', CFG, _('REALITY'),
			_('Settings of the two VLESS transports. Connections without a valid client key are forwarded to the target, a site that answers over TLS 1.3; the server names are the names on its certificate.'));
		this.realitySection = s;

		var targetDesc = _('Address and port that connections without a client key are forwarded to; the certificate there must match the server names. "127.0.0.1:443" is this router\'s own HTTPS site (Tunnel → Dynamic DNS): when a TCP transport of this server runs on that port itself, the site is served behind it on 127.0.0.1:4443 and the target follows. A public site that answers over TLS 1.3, for example "www.samsung.com:443", works too.');
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
			_('The REALITY private key (X25519). Generate it with the button below; the matching public key goes into the VLESS links.'));
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
			return node;
		};

		o = s.option(form.Button, '_keypair', _('New keypair'),
			_('Replaces the private key above. After "Save & Apply" the existing VLESS links stop working until they are exported again.'));
		o.inputtitle = _('Generate keypair');
		o.onclick = L.bind(this.handleKeypair, this);

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

		o = s.option(form.Button, '_short_id', _('New short ID'));
		o.inputtitle = _('Add a random short ID');
		o.onclick = L.bind(this.handleAddShortId, this);

		/* Transports */
		s = m.section(form.NamedSection, 'main', CFG, _('Transports'),
			_('Every transport has its own port; the port is opened from the Internet while the server runs. Every profile works on every enabled transport.'));
		this.transportSection = s;

		o = s.option(form.Flag, 'vision_enabled', _('TCP + XTLS-Vision'),
			_('VLESS + REALITY over TCP with XTLS-Vision, supported by every current client app.'));
		o.rmempty = false;

		o = s.option(form.Value, 'vision_port', _('TCP port'), _('On 443 the server sits in front of the router\'s own site: the Dynamic DNS package serves it behind the server on 127.0.0.1:4443, and connections without a client key are forwarded to it.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.placeholder = '443';
		o.depends('vision_enabled', '1');

		o = s.option(form.Value, 'vision_link_port', _('Port in client links'),
			_('Only when a router in front forwards a different public port to this one. Empty: the port above.'));
		o.datatype = 'port';
		o.placeholder = _('same as the port');
		o.depends('vision_enabled', '1');

		o = s.option(form.Flag, 'xhttp_enabled', _('XHTTP'),
			_('VLESS + REALITY over XHTTP (HTTP requests and responses); needs a client app with the Xray core.'));
		o.rmempty = false;

		o = s.option(form.Value, 'xhttp_port', _('TCP port'), _('Another TCP port than the one of TCP + XTLS-Vision.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.placeholder = '8443';
		o.depends('xhttp_enabled', '1');

		o = s.option(form.Value, 'xhttp_path', _('Path'),
			_('The HTTP path of the XHTTP requests, starting with "/".'));
		o.rmempty = false;
		o.placeholder = '/' + randomHex(4);
		o.depends('xhttp_enabled', '1');
		o.validate = function(section_id, value) {
			return /^\/[A-Za-z0-9._~\/-]*$/.test(String(value || '').trim())
				? true : _('Start with "/" and use letters, digits, ".", "_", "-" and "/"');
		};

		o = s.option(form.Button, '_xhttp_path', _('New path'));
		o.inputtitle = _('Set a random path');
		o.depends('xhttp_enabled', '1');
		o.onclick = function() { self.setTransportValue('xhttp_path', '/' + randomHex(4)); };

		o = s.option(form.ListValue, 'xhttp_mode', _('Mode'), _('"auto" suits every client.'));
		XHTTP_MODES.forEach(function(v) { o.value(v, v); });
		o.default = 'auto';
		o.depends('xhttp_enabled', '1');

		o = s.option(form.Value, 'xhttp_link_port', _('Port in client links'),
			_('Only when a router in front forwards a different public port to this one. Empty: the port above.'));
		o.datatype = 'port';
		o.placeholder = _('same as the port');
		o.depends('xhttp_enabled', '1');

		o = s.option(form.Flag, 'hysteria2_enabled', _('Hysteria2'),
			_('Hysteria2 over QUIC (UDP) with an ordinary TLS certificate for the name clients connect to; the easiest source is a domain from the Dynamic DNS page.'));
		o.rmempty = false;

		o = s.option(form.Value, 'hysteria2_port', _('UDP port'), _('UDP and TCP ports are separate: 443 works next to TCP + XTLS-Vision on 443.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.placeholder = '443';
		o.depends('hysteria2_enabled', '1');

		o = s.option(form.Value, 'hysteria2_link_port', _('Port in client links'),
			_('Only when a router in front forwards a different public UDP port to this one. Empty: the port above.'));
		o.datatype = 'port';
		o.placeholder = _('same as the port');
		o.depends('hysteria2_enabled', '1');

		o = s.option(form.ListValue, 'cert_source', _('Certificate'),
			_('Where the TLS certificate of the Hysteria2 transport comes from. xray reads the files again every hour, so renewals need no restart.'));
		o.value('ddns', _('A domain from the Dynamic DNS page'));
		o.value('files', _('Certificate files on the router'));
		o.default = 'ddns';
		o.depends('hysteria2_enabled', '1');

		o = s.option(form.ListValue, 'cert_domain', _('Domain'),
			_('The Hysteria2 transport answers to this name with its Let\'s Encrypt certificate from the Dynamic DNS page; the name goes into the links.'));
		if (!domains.length)
			o.value('', _('(no domain on the Dynamic DNS page yet)'));
		domains.forEach(function(d) {
			var n = daysLeft(d.expires);
			o.value(d.id, d.hostname + (d.has_cert ? (n != null ? ' (' + _('certificate: %d days left').format(n) + ')' : '') : ' (' + _('no certificate yet') + ')'));
		});
		o.depends({ hysteria2_enabled: '1', cert_source: 'ddns' });

		o = s.option(form.Value, 'cert_name', _('TLS server name'),
			_('The name on the certificate; clients send it as the SNI.'));
		o.datatype = 'hostname';
		o.rmempty = false;
		o.depends({ hysteria2_enabled: '1', cert_source: 'files' });

		o = s.option(form.Value, 'cert_path', _('Certificate file'), _('PEM, the full chain.'));
		o.rmempty = false;
		o.placeholder = '/etc/ssl/certs/example.pem';
		o.depends({ hysteria2_enabled: '1', cert_source: 'files' });
		o.validate = function(section_id, value) {
			return /^\/\S+$/.test(String(value || '').trim()) ? true : _('Enter an absolute path');
		};

		o = s.option(form.Value, 'key_path', _('Private key file'), _('PEM.'));
		o.rmempty = false;
		o.placeholder = '/etc/ssl/private/example.key';
		o.depends({ hysteria2_enabled: '1', cert_source: 'files' });
		o.validate = function(section_id, value) {
			return /^\/\S+$/.test(String(value || '').trim()) ? true : _('Enter an absolute path');
		};

		o = s.option(form.Value, 'hysteria2_obfs', _('Obfuscation password'),
			_('Optional. Salamander obfuscation of the QUIC packets; every client uses the same password (it goes into the links). Empty: off.'));
		o.rmempty = true;
		o.placeholder = _('empty = off');
		o.depends('hysteria2_enabled', '1');

		o = s.option(form.DummyValue, '_obfs_buttons', _('Obfuscation'));
		o.depends('hysteria2_enabled', '1');
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': function() { self.setTransportValue('hysteria2_obfs', randomPassword(16)); } }, _('Random password')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': function() { self.setTransportValue('hysteria2_obfs', ''); } }, _('Clear'))
			]);
		};

		o = s.option(form.Value, 'hysteria2_masquerade', _('Masquerade'),
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

		/* Client links */
		s = m.section(form.NamedSection, 'main', CFG, _('Client links'));

		o = s.option(form.Value, 'link_host', _('Address'),
			(site && site.hostname)
				? _('The public DNS name or IP address of this router that clients connect to. Empty: %s, the domain of the web site from the Dynamic DNS page.').format(site.hostname)
				: _('The public DNS name or IP address of this router that clients connect to, for example a domain from the Dynamic DNS page. Empty: the TLS server name of the Hysteria2 certificate.'));
		o.datatype = 'host';
		o.rmempty = true;
		o.placeholder = (site && site.hostname) ? site.hostname : 'router.example.org';

		/* Profiles */
		s = m.section(form.GridSection, 'profile', _('Profiles'),
			_('Every profile (a person or a device) has a UUID for the VLESS transports and a password for Hysteria2, and works on every enabled transport. "Links" gives a link and a QR code per transport.'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add profile…');
		s.modaltitle = function(sid) {
			return _('Profile') + ' » ' + (uci.get(CFG, sid, 'name') || _('new profile'));
		};

		/* Saving a profile dialog makes LuCI re-render the whole page from its uci store, so the
		   main form's unsaved edits are put into the store before a dialog opens: for a new
		   profile before its section is created (a store save renames new sections), for
		   "Edit" right before the dialog. */
		s.handleAdd = function(ev, name) {
			var args = arguments;
			return this.map.save(null, true).catch(function() {}).then(L.bind(function() {
				this.parentSaved = true;
				return form.GridSection.prototype.handleAdd.apply(this, args);
			}, this));
		};
		s.renderMoreOptionsModal = function(section_id, ev) {
			var args = arguments, saved = this.parentSaved;
			this.parentSaved = false;
			return (saved ? Promise.resolve() : this.map.save(null, true).catch(function() {})).then(L.bind(function() {
				return form.GridSection.prototype.renderMoreOptionsModal.apply(this, args);
			}, this));
		};

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
