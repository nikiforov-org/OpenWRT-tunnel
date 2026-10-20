'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require uqr';

var CFG = 'tunnel-server-hysteria2';

var callStatus  = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callLinks   = rpc.declare({ object: CFG, method: 'links', params: [ 'profile' ], expect: {} });
var callLog     = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callConfig  = rpc.declare({ object: CFG, method: 'config', expect: {} });
var callRestart = rpc.declare({ object: CFG, method: 'restart', expect: {} });

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };
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

function daysLeft(notAfter) {
	var t = Date.parse(notAfter);
	return isNaN(t) ? null : Math.floor((t - Date.now()) / 86400000);
}

function randomPassword(n) {
	return Array.from(crypto.getRandomValues(new Uint8Array(n)), function(b) { return ALPHABET[b % ALPHABET.length]; }).join('');
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
			return span(COLOR.bad, _('sing-box is not installed on the router. It is a dependency of this package: run "apk update && apk add sing-box".'));
		if (!st.enabled)
			return span(COLOR.dim, _('Off — tick "Run the server" below and click "Save & Apply"'));
		if (st.running)
			return span(COLOR.ok, _('Running') + (st.version ? ' (sing-box ' + st.version + ')' : ''));
		var lines = [ span(COLOR.bad, _('Not running')) ];
		if (st.log_last)
			lines.push(E('pre', { 'style': 'color:' + COLOR.dim + '; white-space:pre-wrap; margin:.3em 0 0; font-size:90%' }, st.log_last));
		return E('div', {}, lines);
	},

	overviewAccess: function() {
		var p = this.status.firewall;
		return p
			? span(COLOR.ok, _('Open from the Internet: %s/udp (firewall rule "tunnel-server-hysteria2: UDP from WAN")').format(p))
			: span(COLOR.dim, _('Closed — the port is not open from the Internet'));
	},

	overviewCert: function() {
		var c = this.status.cert || {};
		if (c.error)
			return span(COLOR.warn, c.error);
		var n = daysLeft(c.not_after);
		var col = (c.valid && n != null && n > 14) ? COLOR.ok : COLOR.bad;
		if (n != null && n <= 30 && n > 14) col = COLOR.warn;
		return E('span', {}, [
			span(col, n != null ? _('%s — valid, %d days left').format(c.cn || c.server_name, n) : _('%s — valid until %s').format(c.cn || c.server_name, c.not_after)),
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
			return span(COLOR.ok, _('Written %s to /etc/tunnel-server-hysteria2/config.json').format(timeAgo(st.config_time)));
		return span(COLOR.warn, _('Not written yet'));
	},

	refresh: function() {
		return L.resolveDefault(callStatus(), null).then(L.bind(function(st) {
			if (!st) return;
			this.status = st;
			var el;
			if ((el = document.getElementById('tsh-ov-server'))) dom.content(el, this.overviewServer());
			if ((el = document.getElementById('tsh-ov-access'))) dom.content(el, this.overviewAccess());
			if ((el = document.getElementById('tsh-ov-cert')))   dom.content(el, this.overviewCert());
			if ((el = document.getElementById('tsh-ov-config'))) dom.content(el, this.overviewConfig());
		}, this));
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
					this.showLink(r);
			}, this));
		}, this));
	},

	showLink: function(r) {
		var ta = E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 4, 'readonly': 'readonly' }, r.link);
		var qr = E('div', { 'style': 'margin:1em auto; width:240px' });
		var svg = null;
		try { svg = uqr.renderSVG(r.link, { pixelSize: 4 }); } catch (e) {}
		dom.content(qr, svg ? Object.assign(E(svg), { style: 'width:100%; height:auto' }) : span(COLOR.dim, _('QR code unavailable')));
		ui.showModal(_('Client link') + ' — ' + r.name, [
			E('p', _('Import the link or scan the QR code in the client app. The link holds the profile\'s password, the server address %s and the TLS server name.').format(r.host)),
			E('p', { 'style': 'color:' + COLOR.dim }, r.note || ''),
			ta,
			E('div', { 'style': 'margin:.5em 0' },
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': function() { return copyText(ta.value); } }, _('Copy link'))),
			qr,
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
		]);
	},

	showLog: function(ev) {
		return callLog().then(function(r) {
			textModal(_('sing-box log'), r.log || _('The log is empty.'));
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
				ui.addTimeLimitedNotification(null, E('p', _('sing-box restarted; connections through it reconnect by themselves.')), 5000, 'info');
			return this.refresh();
		}, this));
	},

	setObfs: function(value) {
		var el = this.serverSection.getUIElement('main', 'obfs_password');
		el.setValue(value);
		el.triggerValidation();
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var st = this.status;
		var domains = st.domains || [];
		var m, s, o;

		m = new form.Map(CFG, _('Hysteria2 server'),
			_('A Hysteria2 server (QUIC over UDP, run by sing-box) on this router with a real TLS certificate: devices with a client link connect to it over the Internet and use the router\'s connection. A second way in next to the Xray server, useful where TCP is throttled. Nothing changes on the router until you click "Save & Apply".'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));

		o = s.option(form.DummyValue, '_ov_server', _('Server'));
		o.renderWidget = function() { return E('span', { 'id': 'tsh-ov-server' }, self.overviewServer()); };

		o = s.option(form.DummyValue, '_ov_access', _('Access from the Internet'));
		o.renderWidget = function() { return E('span', { 'id': 'tsh-ov-access' }, self.overviewAccess()); };

		o = s.option(form.DummyValue, '_ov_cert', _('Certificate'));
		o.renderWidget = function() { return E('span', { 'id': 'tsh-ov-cert' }, self.overviewCert()); };

		o = s.option(form.DummyValue, '_ov_config', _('Configuration'));
		o.renderWidget = function() { return E('span', { 'id': 'tsh-ov-config' }, self.overviewConfig()); };

		o = s.option(form.DummyValue, '_tools', _('Tools'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showLog') }, _('Show log')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showConfig') }, _('Show configuration')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleRestart') }, _('Restart sing-box'))
			]);
		};

		/* Server */
		s = m.section(form.NamedSection, 'main', CFG, _('Server'),
			_('Hysteria2 is ordinary TLS 1.3 over QUIC, so the server needs a real certificate for the name clients connect to; the easiest source is a domain from the Dynamic DNS page.'));
		this.serverSection = s;

		o = s.option(form.Flag, 'enabled', _('Run the server'),
			_('Starts sing-box with the settings below and opens the UDP port from the Internet (firewall rule "tunnel-server-hysteria2: UDP from WAN"). Switch off to stop it and close the port.'));
		o.rmempty = false;

		o = s.option(form.Value, 'port', _('UDP port'), _('The port clients connect to.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.placeholder = '443';

		o = s.option(form.ListValue, 'cert_source', _('Certificate'),
			_('Where the TLS certificate comes from.'));
		o.value('ddns', _('A domain from the Dynamic DNS page'));
		o.value('files', _('Certificate files on the router'));
		o.default = 'ddns';

		o = s.option(form.ListValue, 'cert_domain', _('Domain'),
			_('The server answers to this name with its Let\'s Encrypt certificate from the Dynamic DNS page; the name goes into the client links.'));
		if (!domains.length)
			o.value('', _('— no domain on the Dynamic DNS page yet —'));
		domains.forEach(function(d) {
			var n = daysLeft(d.not_after);
			o.value(d.id, d.hostname + (d.has_cert ? (n != null ? ' (' + _('certificate: %d days left').format(n) + ')' : '') : ' (' + _('no certificate yet') + ')'));
		});
		o.depends('cert_source', 'ddns');

		o = s.option(form.Value, 'server_name', _('TLS server name'),
			_('The name on the certificate; clients send it as the SNI.'));
		o.datatype = 'hostname';
		o.rmempty = false;
		o.depends('cert_source', 'files');

		o = s.option(form.Value, 'cert_path', _('Certificate file'), _('PEM, the full chain. sing-box reloads it by itself when the file changes.'));
		o.rmempty = false;
		o.placeholder = '/etc/ssl/certs/example.pem';
		o.depends('cert_source', 'files');
		o.validate = function(section_id, value) {
			return /^\/\S+$/.test(String(value || '').trim()) ? true : _('Enter an absolute path');
		};

		o = s.option(form.Value, 'key_path', _('Private key file'), _('PEM.'));
		o.rmempty = false;
		o.placeholder = '/etc/ssl/private/example.key';
		o.depends('cert_source', 'files');
		o.validate = function(section_id, value) {
			return /^\/\S+$/.test(String(value || '').trim()) ? true : _('Enter an absolute path');
		};

		o = s.option(form.Value, 'obfs_password', _('Obfuscation password'),
			_('Optional. Salamander obfuscation of the QUIC stream; every client must use the same password (it goes into the links). Empty: off.'));
		o.rmempty = true;
		o.placeholder = _('empty = off');

		o = s.option(form.DummyValue, '_obfs_buttons', _('Obfuscation'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': function() { self.setObfs(randomPassword(16)); } }, _('Random password')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': function() { self.setObfs(''); } }, _('Clear'))
			]);
		};

		o = s.option(form.Value, 'masquerade', _('Masquerade'),
			_('What a plain HTTP/3 visitor without a profile password gets: a URL to proxy (http:// or https://, for example https://127.0.0.1:443 for this router\'s own site), file:///path to serve, or a sing-box masquerade object in JSON. Empty: a 404 answer.'));
		o.rmempty = true;
		o.placeholder = _('empty = 404');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v) return true;
			if (v.charAt(0) == '{') {
				try { JSON.parse(v); return true; } catch (e) { return _('Not a valid JSON object'); }
			}
			return /^(https?|file):\/\/\S+$/.test(v) ? true : _('Enter http://, https:// or file:// followed by the address, or a JSON object');
		};

		o = s.option(form.Flag, 'local_access', _('Access to local networks'),
			_('Clients may reach the router itself and the networks behind it (LAN, the router in front) through the server. Off: only the Internet; private addresses are blocked.'));
		o.rmempty = false;
		o.default = '1';

		/* Client links */
		s = m.section(form.NamedSection, 'main', CFG, _('Client links'));

		o = s.option(form.Value, 'link_host', _('Address'),
			_('The public DNS name or IP address of this router that clients connect to. Empty: the TLS server name (the domain).'));
		o.datatype = 'host';
		o.rmempty = true;
		o.placeholder = _('same as the TLS server name');

		o = s.option(form.Value, 'link_port', _('Port in client links'),
			_('Only when a router in front forwards a different public UDP port to this one. Empty: the port above.'));
		o.datatype = 'port';
		o.rmempty = true;
		o.placeholder = _('same as the port');

		/* Profiles */
		s = m.section(form.GridSection, 'profile', _('Profiles'),
			_('Every profile (a person or a device) has its own password. "Link" gives the link and the QR code to import into the client app.'));
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
					'title': _('The link and QR code for the client app'),
					'click': ui.createHandlerFn(self, 'handleLinks', section_id)
				}, _('Link')), ' '
			].concat(existing));
			return tdEl;
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'), _('Switch off to lock this profile out without deleting it.'));
		o.rmempty = false;
		o.default = '1';
		o.editable = true;

		o = s.option(form.Value, 'name', _('Name'), _('Who or which device this is; it appears in the link and in the log.'));
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

		o = s.option(form.Value, 'password', _('Password'), _('The profile\'s password. A random one is filled in for a new profile.'));
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

		o = s.option(form.Button, '_password', _('New password'), _('Replaces the password; the profile\'s link has to be exported again.'));
		o.modalonly = true;
		o.inputtitle = _('Generate');
		o.onclick = function(ev, section_id) {
			var el = this.section.getUIElement(section_id, 'password');
			el.setValue(randomPassword(22));
			el.triggerValidation();
		};

		return m.render().then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 5);
			return nodes;
		}, this));
	}
});
