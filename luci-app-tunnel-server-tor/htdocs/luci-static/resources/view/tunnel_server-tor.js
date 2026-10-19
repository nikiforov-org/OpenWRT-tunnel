'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require uqr';

var CFG = 'tunnel_server-tor';

var callStatus  = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callKeypair = rpc.declare({ object: CFG, method: 'keypair', expect: {} });
var callPubkey  = rpc.declare({ object: CFG, method: 'pubkey', params: [ 'private_key' ], expect: {} });
var callLinks   = rpc.declare({ object: CFG, method: 'links', params: [ 'profile' ], expect: {} });
var callConfig  = rpc.declare({ object: CFG, method: 'config', expect: {} });
var callLog     = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callRestart = rpc.declare({ object: CFG, method: 'restart', expect: {} });

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };

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

function qrNode(text) {
	var svg = null;
	try { svg = uqr.renderSVG(text, { pixelSize: 4 }); } catch (e) {}
	return E('div', { 'style': 'margin:1em auto; width:240px' },
		svg ? Object.assign(E(svg), { style: 'width:100%; height:auto' }) : span(COLOR.dim, _('QR code unavailable')));
}

return view.extend({
	status: {},
	pendingKey: null,
	publicKeyFor: {},

	load: function() {
		return L.resolveDefault(callStatus(), {}).then(L.bind(function(st) {
			this.status = st || {};
		}, this));
	},

	/* ---------- status cells ---------- */

	overviewService: function() {
		var st = this.status;
		if (!st.installed)
			return span(COLOR.bad, _('tor is not installed on the router. It is a dependency of this package: run "apk update && apk add tor obfs4proxy snowflake-client".'));
		if (!st.enabled)
			return span(COLOR.dim, _('Off — tick "Run the onion service" below and click "Save & Apply"'));
		if (st.running) {
			var v = st.version ? ' (tor ' + st.version + ')' : '';
			if (st.bootstrap == null)
				return span(COLOR.ok, _('Running') + v);
			if (st.bootstrap >= 100)
				return span(COLOR.ok, _('Running, connected to the Tor network') + v);
			return span(COLOR.warn, _('Running, connecting to the Tor network: %d%%').format(st.bootstrap) + (st.bootstrap_text ? ' — ' + st.bootstrap_text : '') + v);
		}
		var lines = [ span(COLOR.bad, _('Not running')) ];
		if (st.log_last)
			lines.push(E('pre', { 'style': 'color:' + COLOR.dim + '; white-space:pre-wrap; margin:.3em 0 0; font-size:90%' }, st.log_last));
		return E('div', {}, lines);
	},

	overviewAddress: function() {
		var st = this.status;
		if (!st.onion)
			return span(COLOR.dim, st.enabled ? _('Not known yet: it appears when tor starts the service') : _('Appears once the service runs'));
		return E('span', {}, [
			E('code', { 'style': 'user-select:all' }, st.onion), ' ',
			E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(st.onion); } }, _('Copy')),
			E('div', { 'style': 'color:' + COLOR.dim + '; margin-top:.3em' }, st.enabled
				? _('Reachable through Tor only by the profiles below (with their keys), a minute or two after the service is connected. Ports: %s.').format((st.ports || []).join(', ') || '—')
				: _('The service is off; the address stays and comes back with it.'))
		]);
	},

	overviewConfig: function() {
		var st = this.status;
		if (st.error)
			return span(COLOR.bad, _('Not applied: %s').format(st.error));
		if (!st.enabled)
			return span(COLOR.dim, _('No configuration file while the service is off'));
		if (st.config_time)
			return span(COLOR.ok, _('Written %s to /etc/tunnel_server-tor/torrc').format(timeAgo(st.config_time)));
		return span(COLOR.warn, _('Not written yet'));
	},

	profileState: function(sid) {
		var st = this.status, p = null;
		(st.profiles || []).forEach(function(x) { if (x.sid == sid) p = x; });
		if (!p) return span(COLOR.dim, _('not saved yet'));
		if (!p.enabled) return span(COLOR.dim, _('off'));
		if (p.authorized) return span(COLOR.ok, _('authorized'));
		return span(COLOR.warn, st.enabled ? _('not applied yet') : _('waits for the service'));
	},

	refresh: function() {
		return L.resolveDefault(callStatus(), null).then(L.bind(function(st) {
			if (!st) return;
			this.status = st;
			var el;
			if ((el = document.getElementById('tst-ov-service'))) dom.content(el, this.overviewService());
			if ((el = document.getElementById('tst-ov-address'))) dom.content(el, this.overviewAddress());
			if ((el = document.getElementById('tst-ov-config')))  dom.content(el, this.overviewConfig());
			var self = this;
			(st.profiles || []).forEach(function(p) {
				var cell = document.getElementById('tst-profile-' + p.sid);
				if (cell) dom.content(cell, self.profileState(p.sid));
			});
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
		var key = r.auth_line.split(':').pop();
		var line = E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 2, 'readonly': 'readonly' }, r.auth_line);
		ui.showModal(_('Client key') + ' — ' + r.name, [
			E('p', _('Address of this router in the Tor network:')),
			E('p', {}, E('code', { 'style': 'user-select:all; word-break:break-all' }, r.onion)),
			E('p', _('Tor Browser: open the address (with the port, for example http://%s:%s/), paste the private key when it asks for one:').format(r.onion, r.ports[0] || 80)),
			E('p', {}, E('code', { 'style': 'user-select:all; word-break:break-all' }, key)),
			E('p', _('A tor daemon on a computer or server (Orbot, a tor client in front of an Xray or SSH client): put this line into the file "%s" in its ClientOnionAuthDir:').format(r.auth_file)),
			line,
			E('div', { 'style': 'margin:.5em 0' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': function() { return copyText(key); } }, _('Copy the key')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(line.value); } }, _('Copy the line'))
			]),
			E('p', { 'style': 'color:' + COLOR.dim }, (r.xray
				? _('Ports of this router through the address: %s. The Xray server answers on %s:8443 too, so an Xray client can be pointed at it through a local tor.').format(r.ports.join(', '), r.onion)
				: _('Ports of this router through the address: %s.').format(r.ports.join(', ')))),
			qrNode(r.auth_line),
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
		]);
	},

	showLog: function(ev) {
		return callLog().then(function(r) {
			textModal(_('tor log'), r.log || _('The log is empty.'));
		});
	},

	showConfig: function(ev) {
		return callConfig().then(function(r) {
			textModal(_('Generated configuration'), r.config || _('There is no configuration file: the service is off or the settings have not been applied yet.'),
				E('p', { 'style': 'color:' + COLOR.dim }, (r.path || '') + ((r.clients || []).length ? ' — ' + _('authorized clients: %s').format(r.clients.join(', ')) : '')));
		});
	},

	handleRestart: function(ev) {
		return callRestart().then(L.bind(function(r) {
			if (r.error || !r.ok)
				ui.addNotification(null, E('p', r.error || r.log || _('Restart failed.')), 'error');
			else
				ui.addTimeLimitedNotification(null, E('p', _('tor restarted; it connects to the Tor network again, which takes a minute.')), 5000, 'info');
			return this.refresh();
		}, this));
	},

	/* section: the dialog's own section (LuCI renders a dialog as a separate map, the page map does not see its fields) */
	newKeys: function(section, section_id) {
		return callKeypair().then(L.bind(function(r) {
			if (r.error) {
				ui.addNotification(null, E('p', r.error), 'error');
				return;
			}
			var el = section.getUIElement(section_id, 'private_key');
			el.setValue(r.private_key);
			el.triggerValidation();
			this.showPublicKey(section_id, r.private_key, r.public_key);
		}, this));
	},

	showPublicKey: function(section_id, priv, pub) {
		this.publicKeyFor[priv] = pub;
		var cell = document.getElementById('tst-pub-' + section_id);
		if (!cell) return;
		dom.content(cell, pub ? E('code', { 'style': 'user-select:all; word-break:break-all' }, pub)
		                      : span(COLOR.dim, _('— enter a valid private key —')));
	},

	updatePublicKey: function(section_id, priv) {
		priv = String(priv || '').trim();
		if (this.publicKeyFor[priv] !== undefined)
			return this.showPublicKey(section_id, priv, this.publicKeyFor[priv]);
		if (!/^[A-Z2-7]{52}$/.test(priv))
			return this.showPublicKey(section_id, priv, '');
		return callPubkey(priv).then(L.bind(function(r) {
			this.showPublicKey(section_id, priv, r.public_key || '');
		}, this));
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var st = this.status;
		var m, s, o;

		m = new form.Map(CFG, _('Tor onion service'),
			_('This router as an onion service: an address in the Tor network that reaches the router\'s own ports (SSH, the web interface, the Xray server) from anywhere, without a public IP address, open ports or a domain. Only the profiles below can use it, each with its own key. Nothing changes on the router until you click "Save & Apply".'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));

		o = s.option(form.DummyValue, '_ov_service', _('Service'));
		o.renderWidget = function() { return E('span', { 'id': 'tst-ov-service' }, self.overviewService()); };

		o = s.option(form.DummyValue, '_ov_address', _('Onion address'));
		o.renderWidget = function() { return E('span', { 'id': 'tst-ov-address' }, self.overviewAddress()); };

		o = s.option(form.DummyValue, '_ov_config', _('Configuration'));
		o.renderWidget = function() { return E('span', { 'id': 'tst-ov-config' }, self.overviewConfig()); };

		o = s.option(form.DummyValue, '_tools', _('Tools'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showLog') }, _('Show log')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showConfig') }, _('Show configuration')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleRestart') }, _('Restart tor'))
			]);
		};

		/* Settings */
		s = m.section(form.NamedSection, 'main', CFG, _('Settings'),
			_('The router\'s tor connects to the Tor network itself; where direct connections to Tor are blocked, it goes through bridges. The onion address is created on the first start and kept in /etc/tor/tunnel_server-tor.'));

		o = s.option(form.Flag, 'enabled', _('Run the onion service'),
			_('Starts tor with the settings below. No firewall port is opened: the router makes the connections itself. Switch off to stop it.'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'bridges', _('Bridges'),
			_('How tor reaches the Tor network.'));
		o.value('builtin', _('Built-in bridges (snowflake and obfs4, the set shipped with the package)'));
		o.value('custom', _('Bridges entered below'));
		o.value('none', _('No bridges: connect directly'));
		o.default = 'builtin';

		o = s.option(form.DynamicList, 'bridge', _('Bridge lines'),
			_('One bridge per entry, as given by bridges.torproject.org or Telegram @GetBridgesBot, with or without the leading "Bridge": for example "obfs4 192.0.2.1:443 FINGERPRINT cert=… iat-mode=0".'));
		o.depends('bridges', 'custom');
		o.rmempty = true;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim().replace(/^Bridge\s+/, '');
			if (!v) return true;
			if (/^(obfs4|snowflake|meek_lite|webtunnel) \S+:\d+ [0-9A-Fa-f]{40}( \S+)*$/.test(v) || /^\S+:\d+ [0-9A-Fa-f]{40}$/.test(v)) return true;
			return _('Expected "transport address:port fingerprint …" or "address:port fingerprint"');
		};

		o = s.option(form.DynamicList, 'port', _('Ports'),
			_('Ports of this router reachable through the onion address, each to the same port on the router itself: 22 is SSH, 80 the web interface (or the site), 8443 the Xray server.'));
		o.datatype = 'port';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v) return true;
			return /^\d{1,5}$/.test(v) && parseInt(v, 10) >= 1 && parseInt(v, 10) <= 65535 ? true : _('Enter a port number');
		};

		/* Profiles */
		s = m.section(form.GridSection, 'profile', _('Profiles'),
			_('Every profile (a person or a device) has its own key; only its holders can reach the onion address. "Key" shows what to enter in Tor Browser or a tor daemon.'));
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
		   "Edit" right before the dialog. A new profile gets a key pair from the router first. */
		s.handleAdd = function(ev, name) {
			var args = arguments;
			return this.map.save(null, true).catch(function() {}).then(function() {
				return L.resolveDefault(callKeypair(), {});
			}).then(L.bind(function(r) {
				self.pendingKey = (r && r.private_key) ? r : null;
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
					'title': _('The key for Tor Browser or a tor daemon'),
					'click': ui.createHandlerFn(self, 'handleLinks', section_id)
				}, _('Key')), ' '
			].concat(existing));
			return tdEl;
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'), _('Switch off to lock this profile out without deleting it.'));
		o.rmempty = false;
		o.default = '1';
		o.editable = true;

		o = s.option(form.Value, 'name', _('Name'), _('Who or which device this is: letters, digits, dots, dashes and underscores; it is the file name on the client side.'));
		o.rmempty = false;
		o.placeholder = _('laptop');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) return _('1 to 64 characters: letters, digits, dots, dashes, underscores');
			var dup = false;
			uci.sections(CFG, 'profile', function(c) {
				if (c['.name'] != section_id && String(c.name || '').toLowerCase() == v.toLowerCase()) dup = true;
			});
			return dup ? _('Another profile has this name') : true;
		};

		o = s.option(form.DummyValue, '_state', _('State'));
		o.modalonly = false;
		o.editable = true;                         /* rendered through renderWidget in the table */
		o.renderWidget = function(section_id) {
			return E('span', { 'id': 'tst-profile-' + section_id }, self.profileState(section_id));
		};

		o = s.option(form.Value, 'private_key', _('Private key'),
			_('The client\'s x25519 key, base32 (52 characters). A new pair is generated on the router for a new profile; the router keeps only what it needs (the public key goes into the service), the private key is what the client enters.'));
		o.modalonly = true;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			self.updatePublicKey(section_id, v);
			return /^[A-Z2-7]{52}$/.test(v) ? true : _('52 characters of base32: A–Z and 2–7');
		};
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			var value = cfgvalue;
			if (value == null && self.pendingKey) {
				value = self.pendingKey.private_key;
				self.publicKeyFor[value] = self.pendingKey.public_key;
				self.pendingKey = null;
			}
			var node = form.Value.prototype.renderWidget.call(this, section_id, option_index, value);
			window.setTimeout(function() { self.updatePublicKey(section_id, value); }, 0);
			return node;
		};

		o = s.option(form.DummyValue, '_public', _('Public key'), _('Derived from the private key; this is what the router stores as the profile\'s authorization.'));
		o.modalonly = true;
		o.renderWidget = function(section_id) {
			return E('span', { 'id': 'tst-pub-' + section_id }, span(COLOR.dim, '…'));
		};

		o = s.option(form.Button, '_newkeys', _('New keys'), _('Replaces the key pair; the client has to get the new key.'));
		o.modalonly = true;
		o.inputtitle = _('Generate');
		o.onclick = function(ev, section_id) {
			return self.newKeys(this.section, section_id);
		};

		return m.render().then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 5);
			return nodes;
		}, this));
	}
});
