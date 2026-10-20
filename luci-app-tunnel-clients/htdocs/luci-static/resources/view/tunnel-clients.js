'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';

var CFG = 'tunnel-clients';

var callStatus        = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callMeasure       = rpc.declare({ object: CFG, method: 'measure', expect: {} });
var callUpdateSources = rpc.declare({ object: CFG, method: 'update_sources', expect: {} });
var callLog           = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callConfig        = rpc.declare({ object: CFG, method: 'config', expect: {} });
var callRestart       = rpc.declare({ object: CFG, method: 'restart', expect: {} });

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

function speedText(bps) {
	if (!bps) return '—';
	if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
	return Math.round(bps / 1024) + ' KB/s';
}

function textModal(title, text, header) {
	ui.showModal(title, [
		header || '',
		E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 24, 'readonly': 'readonly' }, text),
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
	]);
}

function allClients(st) {
	var out = [];
	(st.packages || []).forEach(function(p) { (p.clients || []).forEach(function(c) { out.push(c); }); });
	return out;
}

function clientLabel(c) {
	return c.title + ': ' + (c.name || c.tag) + (c.transport ? ' (' + c.transport + ')' : '');
}

return view.extend({
	status: {},

	load: function() {
		return L.resolveDefault(callStatus(), {}).then(L.bind(function(st) {
			this.status = st || {};
		}, this));
	},

	/* ---------- overview cells ---------- */

	overviewService: function() {
		var st = this.status;
		if (!st.installed)
			return span(COLOR.bad, _('xray is not installed on the router. It is a dependency of this package: run "apk update && apk add xray-core".'));
		if (!st.enabled)
			return span(COLOR.dim, _('Off — tick "Route the LAN through the clients" below and click "Save & Apply"'));
		if (st.running)
			return span(COLOR.ok, _('Running: the LAN reaches the Internet only through this router\'s xray (interception of the LAN, kill switch), IPv6 is off for the LAN') + (st.version ? ' (Xray ' + st.version + ')' : ''));
		var lines = [ span(COLOR.bad, _('Not running — the LAN has no way to the Internet until it starts (kill switch)')) ];
		if (st.log_last)
			lines.push(E('pre', { 'style': 'color:' + COLOR.dim + '; white-space:pre-wrap; margin:.3em 0 0; font-size:90%' }, st.log_last));
		return E('div', {}, lines);
	},

	overviewActive: function() {
		var st = this.status, clients = allClients(st);
		if (!clients.length)
			return span(COLOR.warn, _('No clients yet: add a link in a section below (the client packages are listed there) and apply'));
		var cur = clients.filter(function(c) { return c.tag == st.active_now; })[0];
		var text = cur ? clientLabel(cur) : (st.running ? _('none selected') : '—');
		var parts = [ span(cur ? COLOR.ok : COLOR.dim, text) ];
		if (st.mode == 'manual')
			parts.push(' ', span(COLOR.dim, _('(chosen by hand)')));
		else if (st.auto && st.auto.time)
			parts.push(' ', span(COLOR.dim, _('(automatic: %s, %s)').format(st.auto.reason || '', timeAgo(st.auto.time))));
		return E('span', {}, parts);
	},

	overviewLists: function() {
		var st = this.status, s = st.state || {};
		if (!st.enabled) return span(COLOR.dim, '—');
		var own = s.own || {}, parts = [];
		parts.push(_('own entries: %d domains, %d subnets').format(own.domains || 0, own.ips || 0));
		(s.sources || []).forEach(function(src) {
			if (!src.enabled) return;
			if (!src.ready) { parts.push(_('%s: not fetched yet%s').format(src.name, src.error ? ' (' + src.error + ')' : '')); return; }
			parts.push(src.format == 'dat'
				? _('%s: list "%s" of a .dat file, fetched %s').format(src.name, src.tag, timeAgo(src.time))
				: _('%s: %d domains, %d subnets, fetched %s').format(src.name, src.domains, src.ips, timeAgo(src.time)));
		});
		parts.push(_('in effect: %d domain rules, %d subnets').format(s.domains || 0, s.ips || 0));
		return E('span', {}, parts.join('; ') + (st.updating ? ' — ' + _('updating…') : ''));
	},

	overviewMeasure: function() {
		var st = this.status, m = st.measure || {};
		if (!st.enabled) return span(COLOR.dim, '—');
		if (st.measuring) return span(COLOR.warn, _('Measuring…'));
		if (!m.time) return span(COLOR.dim, _('Not measured yet'));
		return E('span', {}, [ _('Last measurement %s').format(timeAgo(m.time)), m.decision ? ': ' + m.decision : '',
			(m.health && m.health.time) ? ' — ' + (m.health.ok ? _('health check %s: OK').format(timeAgo(m.health.time)) : _('health check %s failed: %s').format(timeAgo(m.health.time), m.health.error)) : '' ]);
	},

	overviewConfig: function() {
		var st = this.status;
		if (st.error)
			return span(COLOR.bad, _('Not applied: %s').format(st.error));
		if (!st.enabled)
			return span(COLOR.dim, _('No configuration file while the page is off'));
		if (st.config_time)
			return span(COLOR.ok, _('Written %s to /etc/tunnel-clients/config.json').format(timeAgo(st.config_time)));
		return span(COLOR.warn, _('Not written yet'));
	},

	clientsTable: function() {
		var self = this, st = this.status, clients = allClients(st);
		if (!clients.length)
			return E('em', {}, _('No clients. Add links in the sections below.'));
		var rows = [ E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, _('Client')), E('th', { 'class': 'th' }, _('Server')), E('th', { 'class': 'th' }, _('State')),
			E('th', { 'class': 'th' }, _('Speed')), E('th', { 'class': 'th' }, _('Latency')), E('th', { 'class': 'th' }, _('Measured')), E('th', { 'class': 'th' }, '')
		]) ];
		clients.forEach(function(c) {
			var m = c.measure, state;
			if (c.error) state = span(COLOR.bad, c.error);
			else if (!c.enabled) state = span(COLOR.dim, _('off'));
			else if (!c.ready) state = span(COLOR.warn, _('xray is not running'));
			else state = span(COLOR.ok, _('ready') + (c.active ? ' — ' + _('active') : ''));
			var hist = (c.history || []).slice(-6).map(function(h) { return h.ok ? speedText(h.speed) : '×'; }).join(', ');
			rows.push(E('tr', { 'class': 'tr', 'style': c.active ? 'font-weight:bold' : '' }, [
				E('td', { 'class': 'td' }, clientLabel(c)),
				E('td', { 'class': 'td' }, c.server_host ? c.server_host + ':' + c.server_port : '—'),
				E('td', { 'class': 'td' }, state),
				E('td', { 'class': 'td', 'title': hist }, m ? (m.ok ? speedText(m.speed) : span(COLOR.bad, m.error || _('failed'))) : '—'),
				E('td', { 'class': 'td' }, (m && m.ok) ? Math.round(m.latency * 1000) + ' ms' : '—'),
				E('td', { 'class': 'td' }, m ? timeAgo(m.time) : '—'),
				E('td', { 'class': 'td' }, (st.mode == 'manual' && c.enabled && !c.error)
					? E('button', { 'class': 'btn cbi-button', 'click': function() { self.chooseClient(c.tag); } }, _('Choose'))
					: '')
			]));
		});
		return E('table', { 'class': 'table' }, rows);
	},

	refresh: function() {
		return L.resolveDefault(callStatus(), null).then(L.bind(function(st) {
			if (!st) return;
			this.status = st;
			var el;
			if ((el = document.getElementById('tcl-ov-service'))) dom.content(el, this.overviewService());
			if ((el = document.getElementById('tcl-ov-active')))  dom.content(el, this.overviewActive());
			if ((el = document.getElementById('tcl-ov-lists')))   dom.content(el, this.overviewLists());
			if ((el = document.getElementById('tcl-ov-measure'))) dom.content(el, this.overviewMeasure());
			if ((el = document.getElementById('tcl-ov-config')))  dom.content(el, this.overviewConfig());
			if ((el = document.getElementById('tcl-clients')))    dom.content(el, this.clientsTable());
		}, this));
	},

	/* The page holds several maps (this package's and one per client package). LuCI's default
	   save calls map.save() on each, and every call sends the whole pending change set again,
	   so the second one fails on an already deleted option: parse every map, save once. */
	handleSave: function(ev) {
		var maps = this.maps || [];
		maps.forEach(function(m) { m.checkDepends(); });
		return Promise.all(maps.map(function(m) { return m.parse(); })).then(function() {
			return uci.save();
		}).then(function() {
			return Promise.all(maps.map(function(m) { return m.load().then(function() { return m.renderContents(); }); }));
		}).catch(function(e) {
			ui.showModal(_('Save error'), [
				E('p', {}, _('An error occurred while saving the form:')),
				E('p', {}, E('em', { 'style': 'white-space:pre-wrap' }, e.message)),
				E('div', { 'class': 'right' }, E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Dismiss')))
			]);
			return Promise.reject(e);
		});
	},

	/* ---------- actions ---------- */

	chooseClient: function(tag) {
		var el = this.mainSection.getUIElement('main', 'active');
		if (el) { el.setValue(tag); el.triggerValidation(); }
		ui.addTimeLimitedNotification(null, E('p', _('Chosen; click "Save & Apply" to switch.')), 5000, 'info');
	},

	handleMeasure: function(ev) {
		return callMeasure().then(L.bind(function(r) {
			ui.addTimeLimitedNotification(null, E('p', r.running ? _('A measurement is already running.') : _('Measuring every client; the table updates when it is done.')), 5000, 'info');
			return this.refresh();
		}, this));
	},

	handleUpdateSources: function(ev) {
		return callUpdateSources().then(L.bind(function(r) {
			ui.addTimeLimitedNotification(null, E('p', r.running ? _('An update is already running.') : _('Fetching the list sources in the background.')), 5000, 'info');
			return this.refresh();
		}, this));
	},

	showLog: function(ev) {
		return callLog().then(function(r) {
			textModal(_('Log'), r.log || _('The log is empty.'));
		});
	},

	showConfig: function(ev) {
		return callConfig().then(function(r) {
			textModal(_('Generated configuration'), r.config || _('There is no configuration file: the page is off or the settings have not been applied yet.'),
				E('p', { 'style': 'color:' + COLOR.dim }, r.path || ''));
		});
	},

	handleRestart: function(ev) {
		return callRestart().then(L.bind(function(r) {
			if (r.error || !r.ok)
				ui.addNotification(null, E('p', r.error || r.log || _('Restart failed.')), 'error');
			else
				ui.addTimeLimitedNotification(null, E('p', _('xray restarted; connections of the LAN reconnect by themselves.')), 5000, 'info');
			return this.refresh();
		}, this));
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var st = this.status;
		var clients = allClients(st);
		var m, s, o;

		m = new form.Map(CFG, _('Tunnel clients'),
			_('The devices connected to this router reach the Internet through tunnel clients: links to Xray or Hysteria2 servers (a VPS, another router) are added in the sections at the bottom, one of them is active, by hand or by the measured speed. The traffic of the LAN is split by a list of domains and subnets; nothing of it bypasses the clients (kill switch) and IPv6 is switched off for the LAN while the page is on. Nothing changes on the router until you click "Save & Apply".'));

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));
		o = s.option(form.DummyValue, '_ov_service', _('Service'));
		o.renderWidget = function() { return E('span', { 'id': 'tcl-ov-service' }, self.overviewService()); };
		o = s.option(form.DummyValue, '_ov_active', _('Active client'));
		o.renderWidget = function() { return E('span', { 'id': 'tcl-ov-active' }, self.overviewActive()); };
		o = s.option(form.DummyValue, '_ov_measure', _('Measurement'));
		o.renderWidget = function() { return E('span', { 'id': 'tcl-ov-measure' }, self.overviewMeasure()); };
		o = s.option(form.DummyValue, '_ov_lists', _('Lists'));
		o.renderWidget = function() { return E('span', { 'id': 'tcl-ov-lists' }, self.overviewLists()); };
		o = s.option(form.DummyValue, '_ov_config', _('Configuration'));
		o.renderWidget = function() { return E('span', { 'id': 'tcl-ov-config' }, self.overviewConfig()); };
		o = s.option(form.DummyValue, '_tools', _('Tools'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleMeasure') }, _('Measure now')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'handleUpdateSources') }, _('Update the lists')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showLog') }, _('Show log')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showConfig') }, _('Show configuration')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'handleRestart') }, _('Restart xray'))
			]);
		};

		/* Clients */
		s = m.section(form.NamedSection, 'main', CFG, _('Clients'),
			_('Every link of the sections below is a client. The speed is a download of the test payload through each client (by default from the server\'s own site through the tunnel, https://127.0.0.1/cgi-bin/speed, served by the site of luci-app-tunnel-ddns; a link may name another URL); the latency is the time to the first byte.'));
		o = s.option(form.DummyValue, '_clients', _('Clients'));
		o.renderWidget = function() { return E('div', { 'id': 'tcl-clients' }, self.clientsTable()); };

		/* Settings */
		s = m.section(form.NamedSection, 'main', CFG, _('Settings'));
		this.mainSection = s;

		o = s.option(form.Flag, 'enabled', _('Route the LAN through the clients'),
			_('On: the LAN reaches the Internet only through this router\'s xray, which intercepts every connection of the LAN devices (TPROXY) and sends it to the active client or directly by the list; the lan → wan forwarding is switched off and IPv6 is switched off for the LAN. If xray stops, the LAN has no Internet (kill switch); ping and other protocols besides TCP and UDP do not leave the LAN meanwhile. Off: everything as before.'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'mode', _('Choice of the client'));
		o.value('auto', _('Automatic: the fastest by the measurements'));
		o.value('manual', _('By hand'));
		o.default = 'auto';

		o = s.option(form.ListValue, 'active', _('Active client'), _('Strictly this one; if it fails the LAN waits for it.'));
		if (!clients.length) o.value('', _('— no clients yet —'));
		clients.forEach(function(c) { if (c.enabled && !c.error) o.value(c.tag, clientLabel(c)); });
		o.depends('mode', 'manual');

		o = s.option(form.Value, 'test_interval', _('Measure every, minutes'), _('The test download through every client; in the automatic mode the fastest one becomes active. A health check of the active client runs every minute; when it fails, the measurement runs at once.'));
		o.datatype = 'range(1,1440)';
		o.placeholder = '10';
		o.rmempty = false;

		o = s.option(form.Value, 'test_bytes', _('Test download, bytes'), _('10 000 to 20 000 000.'));
		o.datatype = 'range(10000,20000000)';
		o.placeholder = '5000000';
		o.rmempty = false;

		o = s.option(form.Value, 'test_threshold', _('Switch when faster by, %'), _('Automatic mode: another client replaces the active one only when it is faster by at least this much; a failed active client is replaced at once.'));
		o.datatype = 'range(0,1000)';
		o.placeholder = '20';
		o.rmempty = false;

		o = s.option(form.Value, 'test_timeout', _('Test timeout, seconds'));
		o.datatype = 'range(5,300)';
		o.placeholder = '30';
		o.rmempty = false;

		o = s.option(form.Value, 'resolver', _('DNS through the tunnel'),
			_('The resolver asked through the active client for the names that go through the tunnel. The other names are resolved through the provider\'s resolvers as before; the names of the servers themselves always are.'));
		o.datatype = 'ip4addr';
		o.placeholder = '1.1.1.1';
		o.rmempty = false;

		/* The list */
		s = m.section(form.NamedSection, 'main', CFG, _('Split tunnelling'),
			_('Which traffic of the LAN goes through the clients. The list holds domains (with their subdomains), subnets, and sources fetched daily.'));

		o = s.option(form.Flag, 'split', _('Split by the list'), _('Off: everything from the LAN goes through the active client.'));
		o.rmempty = false;
		o.default = '1';

		o = s.option(form.ListValue, 'split_mode', _('Through the clients goes'));
		o.value('list', _('only what is in the list'));
		o.value('except', _('everything except the list'));
		o.default = 'list';
		o.depends('split', '1');

		o = s.option(form.DynamicList, 'rule', _('Entries'),
			_('A domain (example.com covers its subdomains; names in other alphabets in their punycode form, e.g. xn--p1ai for рф) or a subnet (10.1.2.0/24, a single address as 10.1.2.3).'));
		o.depends('split', '1');
		o.rmempty = true;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim().toLowerCase();
			if (!v) return true;
			if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(v)) return true;
			v = v.replace(/^\*?\./, '');
			return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v) ? true : _('A domain or a subnet');
		};

		s = m.section(form.GridSection, 'source', _('Sources'),
			_('Lists fetched once a day, through the active client when one works: a text file with one domain or IPv4 subnet per line (the v2fly domain-list-community format with include: is understood), or a v2fly .dat file with the kind and the tag of the list inside it. Shipped: the IPv4 networks of Russia (ipverse) and the main Russian services (v2fly category-ru).'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add source…');
		s.modaltitle = function(sid) { return _('Source') + ' » ' + (uci.get(CFG, sid, 'name') || _('new source')); };
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
		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.rmempty = false;
		o.default = '1';
		o.editable = true;
		o = s.option(form.Value, 'name', _('Name'), _('Letters, digits, dots, dashes; it is the file name on the router.'));
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return /^[A-Za-z0-9._-]{1,64}$/.test(String(value || '').trim()) ? true : _('1 to 64 characters: letters, digits, dots, dashes');
		};
		o = s.option(form.Value, 'url', _('URL'));
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return /^https?:\/\/\S+$/.test(String(value || '').trim()) ? true : _('http:// or https:// address');
		};
		o = s.option(form.ListValue, 'kind', _('Kind'), _('Only for a v2fly .dat file: whether the list inside it holds addresses (geoip) or domains (geosite).'));
		o.modalonly = true;
		o.value('', _('a text list'));
		o.value('ip', _('addresses (geoip .dat)'));
		o.value('domain', _('domains (geosite .dat)'));
		o.rmempty = true;
		o = s.option(form.Value, 'tag', _('List in the file'), _('The name of the list inside the .dat file, for example "ru" or "category-ru".'));
		o.modalonly = true;
		o.rmempty = true;
		o.depends('kind', 'ip');
		o.depends('kind', 'domain');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			return (!v || /^[A-Za-z0-9!@._-]+$/.test(v)) ? true : _('Letters, digits, dots, dashes');
		};
		o = s.option(form.DummyValue, '_state', _('Fetched'));
		o.modalonly = false;
		o.editable = true;
		o.renderWidget = function(section_id) {
			var name = uci.get(CFG, section_id, 'name'), src = ((self.status.state || {}).sources || []).filter(function(x) { return x.sid == section_id || x.name == name; })[0];
			if (!src) return span(COLOR.dim, _('not applied yet'));
			if (!src.ready) return span(src.error ? COLOR.bad : COLOR.dim, src.error || _('not fetched yet'));
			var txt = (src.format == 'dat')
				? _('list "%s" (%s) of a .dat file').format(src.tag, src.kind == 'ip' ? _('addresses') : _('domains'))
				: _('%d domains, %d subnets').format(src.domains, src.ips);
			return E('span', {}, [ span(COLOR.ok, txt + ', ' + timeAgo(src.time)),
				src.error ? E('div', { 'style': 'color:' + COLOR.warn }, _('last update: %s').format(src.error)) : '' ]);
		};

		/* One section per installed client package: its links */
		var maps = [ m ];
		(st.packages || []).forEach(function(pkg) {
			var pm = new form.Map(pkg.config, _('%s links').format(pkg.title), pkg.description + ' ' + _('Paste the link the server page shows (Link / QR). Each link is a client.'));
			var ps = pm.section(form.GridSection, 'link', _('Links'));
			ps.anonymous = true;
			ps.addremove = true;
			ps.nodescriptions = true;
			ps.addbtntitle = _('Add link…');
			ps.modaltitle = function(sid) { return _('Link') + ' » ' + (uci.get(pkg.config, sid, 'name') || _('new link')); };
			ps.handleAdd = function(ev, name) {
				var args = arguments;
				return this.map.save(null, true).catch(function() {}).then(L.bind(function() {
					this.parentSaved = true;
					return form.GridSection.prototype.handleAdd.apply(this, args);
				}, this));
			};
			ps.renderMoreOptionsModal = function(section_id, ev) {
				var args = arguments, saved = this.parentSaved;
				this.parentSaved = false;
				return (saved ? Promise.resolve() : this.map.save(null, true).catch(function() {})).then(L.bind(function() {
					return form.GridSection.prototype.renderMoreOptionsModal.apply(this, args);
				}, this));
			};
			var po = ps.option(form.Flag, 'enabled', _('Enabled'));
			po.rmempty = false; po.default = '1'; po.editable = true;
			po = ps.option(form.Value, 'name', _('Name'), _('Empty: the name from the link.'));
			po.rmempty = true;
			po = ps.option(form.Value, 'link', _('Link'));
			po.rmempty = false;
			po.validate = function(section_id, value) {
				var v = String(value || '').trim();
				var mm = v.match(/^([a-z0-9]+):\/\/[^@\/?#]*@([^:\/?#]+|\[[0-9a-fA-F:.]+\]):(\d+)/);
				if (!mm) return _('A link of the form scheme://…@host:port');
				return (pkg.schemes || []).indexOf(mm[1]) >= 0 ? true : _('Expected a %s link').format((pkg.schemes || []).map(function(x) { return x + '://'; }).join(' / '));
			};
			po = ps.option(form.DummyValue, '_state', _('State'));
			po.modalonly = false; po.editable = true;
			po.renderWidget = function(section_id) {
				var c = (pkg.clients || []).filter(function(x) { return x.tag == pkg.package.replace('tunnel-client-', '') + '-' + section_id; })[0];
				if (!c) return span(COLOR.dim, _('not applied yet'));
				if (c.error) return span(COLOR.bad, c.error);
				if (!c.enabled) return span(COLOR.dim, _('off'));
				return span(c.ready ? COLOR.ok : COLOR.warn, (c.transport ? c.transport + ', ' : '') + (c.ready ? _('ready') : _('xray is not running')) + (c.active ? ' — ' + _('active') : ''));
			};
			po = ps.option(form.Value, 'test_url', _('URL for the speed test'), _('Empty: https://127.0.0.1/cgi-bin/speed?bytes=… through the tunnel, served by the site of luci-app-tunnel-ddns on the server (with "Access to local networks" on in the server). For other servers: the URL of any file reachable through this client.'));
			po.modalonly = true;
			po.rmempty = true;
			po.placeholder = _('empty = the server\'s own site');
			maps.push(pm);
		});
		this.maps = maps.slice();
		if (!(st.packages || []).length)
			maps.push(null);

		return Promise.all(maps.map(function(x) { return x ? x.render() : Promise.resolve(E('div', { 'class': 'cbi-section' }, E('em', {}, _('No client packages are installed: install luci-app-tunnel-client-xray or luci-app-tunnel-client-hysteria2.')))); })).then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 5);
			return E('div', {}, nodes);
		}, this));
	}
});
