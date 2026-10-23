'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require tools.widgets as widgets';

var CFG = 'xtunnel-client';

var callStatus        = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callMeasure       = rpc.declare({ object: CFG, method: 'measure', expect: {} });
var callUpdateSources = rpc.declare({ object: CFG, method: 'update_sources', expect: {} });
var callLog           = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callConfig        = rpc.declare({ object: CFG, method: 'config', expect: {} });
var callRestart       = rpc.declare({ object: CFG, method: 'restart', expect: {} });

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };
var DIRECT = [ 'vision', 'xhttp', 'hysteria2' ];
var VIA_TOR = [ 'vision_tor', 'xhttp_tor' ];
var PROTOCOLS = DIRECT.concat(VIA_TOR);
var TITLES = { vision: 'TCP + Vision', xhttp: 'XHTTP', hysteria2: 'Hysteria2',
               vision_tor: 'TCP + Vision through Tor', xhttp_tor: 'XHTTP through Tor' };

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

/* a link that can be chosen: of an enabled profile, through Tor only with "Through Tor" on */
function usable(l) {
	return l.enabled && !l.error && (!l.tor || l.tor_on);
}

function linkLabel(l) {
	return (l.profile_name || l.profile) + ': ' + (l.title || TITLES[l.protocol] || l.protocol);
}

/* the state of one link of a profile */
function linkState(l) {
	if (!l) return span(COLOR.dim, _('not applied yet'));
	if (l.error) return span(COLOR.bad, l.error);
	if (!l.enabled) return span(COLOR.dim, _('profile off'));
	if (l.tor && !l.tor_on) return span(COLOR.dim, _('"Through Tor" is off'));
	if (l.tor_down) return span(COLOR.bad, _('the router\'s tor is not running'));
	if (!l.ready) return span(COLOR.warn, _('xray is not running'));
	return span(COLOR.ok, _('ready') + (l.active ? ', ' + _('active') : ''));
}

return view.extend({
	status: {},

	load: function() {
		return L.resolveDefault(callStatus(), {}).then(L.bind(function(st) {
			this.status = st || {};
		}, this));
	},

	links: function() {
		return this.status.links || [];
	},

	/* ---------- overview cells ---------- */

	overviewService: function() {
		var st = this.status;
		if (!st.installed)
			return span(COLOR.bad, _('xray is not installed on the router. It is a dependency of this package: run "apk update && apk add xray-core".'));
		if (!st.enabled)
			return span(COLOR.dim, _('Off: the LAN reaches the Internet as before'));
		if (st.running)
			return span(COLOR.ok, _('Running: the LAN reaches the Internet only through this router\'s xray (interception of the LAN, kill switch), IPv6 is off for the LAN') + (st.version ? ' (Xray ' + st.version + ')' : ''));
		var lines = [ span(COLOR.bad, _('Not running: the LAN has no way to the Internet until it starts (kill switch)')) ];
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
		}, on ? _('Turn the client off') : _('Turn the client on'));
	},

	handleSwitch: function(on, ev) {
		uci.set(CFG, 'main', 'enabled', on ? '1' : '0');
		return this.handleSaveApply(ev, '0');
	},

	overviewActive: function() {
		var st = this.status, links = this.links();
		if (!links.length)
			return span(COLOR.warn, _('No links yet: add a profile with the links of a server below and apply'));
		var cur = links.filter(function(l) { return l.tag == st.active_now; })[0];
		var parts = [ span(cur ? COLOR.ok : COLOR.dim, cur ? linkLabel(cur) : (st.running ? _('none selected') : '—')) ];
		if (st.mode == 'manual')
			parts.push(' ', span(COLOR.dim, _('(chosen by hand)')));
		else if (st.auto && st.auto.time)
			parts.push(' ', span(COLOR.dim, _('(automatic: %s, %s)').format(st.auto.reason || '', timeAgo(st.auto.time))));
		return E('span', {}, parts);
	},

	overviewTor: function() {
		var t = this.status.tor || {};
		if (!t.used)
			return span(COLOR.dim, _('not used (no links through Tor in effect)'));
		if (!t.running)
			return span(COLOR.bad, _('The router\'s tor is not running, so the links through Tor do not work (its settings: XTunnel → Server, section Tor).'));
		return span(COLOR.ok, _('The links through Tor go through the router\'s tor (SOCKS %s)').format(t.socks) +
			(t.keys ? '; ' + _('client keys of onion services: %d').format(t.keys) : ''));
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
		return E('span', {}, parts.join('; ') + (st.updating ? ' (' + _('updating…') + ')' : ''));
	},

	/* when the measurements run: they choose between links, so only in the automatic mode with two or more */
	measureSchedule: function() {
		var st = this.status, n = ((st.state || {}).clients || []).length;
		var metered = L.toArray(uci.get(CFG, 'main', 'metered'));
		if (st.mode == 'manual') return _('chosen by hand: measured on request only');
		if (n < 2) return _('one link: measured on request only');
		if (st.uplink && metered.indexOf(st.uplink) >= 0) return _('paused while the Internet goes through %s (metered)').format(st.uplink);
		return _('every %d minutes, the active link is checked every minute').format(+(uci.get(CFG, 'main', 'test_interval') || 60));
	},

	overviewMeasure: function() {
		var st = this.status, m = st.measure || {}, h = m.health;
		if (!st.enabled) return span(COLOR.dim, '—');
		if (st.measuring) return span(COLOR.warn, _('Measuring…'));
		var parts = [ m.time ? _('Last measurement %s').format(timeAgo(m.time)) + (m.decision ? ': ' + m.decision : '') : _('Not measured yet') ];
		if (h && h.time)
			parts.push(h.ok ? _('health check %s: OK').format(timeAgo(h.time))
			                : _('health check %s failed: %s').format(timeAgo(h.time), h.error) + (h.decision ? '; ' + h.decision : ''));
		parts.push(this.measureSchedule());
		return E('span', {}, parts.join('; '));
	},

	overviewConfig: function() {
		var st = this.status;
		if (st.error)
			return span(COLOR.bad, _('Not applied: %s').format(st.error));
		if (!st.enabled)
			return span(COLOR.dim, _('No configuration file while the client is off'));
		if (st.config_time)
			return span(COLOR.ok, _('Written %s to /etc/xtunnel-client/config.json').format(timeAgo(st.config_time)));
		return span(COLOR.warn, _('Not written yet'));
	},

	clientsTable: function() {
		var self = this, st = this.status, links = this.links();
		if (!links.length)
			return E('em', {}, _('No links. Add a profile below.'));
		var rows = [ E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, _('Link')), E('th', { 'class': 'th' }, _('Server')), E('th', { 'class': 'th' }, _('State')),
			E('th', { 'class': 'th' }, _('Speed')), E('th', { 'class': 'th' }, _('Latency')), E('th', { 'class': 'th' }, _('Measured')), E('th', { 'class': 'th' }, '')
		]) ];
		links.forEach(function(l) {
			var m = l.measure;
			var hist = (l.history || []).slice(-6).map(function(h) { return h.ok ? speedText(h.speed) : '×'; }).join(', ');
			rows.push(E('tr', { 'class': 'tr', 'style': l.active ? 'font-weight:bold' : '' }, [
				E('td', { 'class': 'td' }, linkLabel(l)),
				E('td', { 'class': 'td' }, l.server_host ? l.server_host + ':' + l.server_port : '—'),
				E('td', { 'class': 'td' }, linkState(l)),
				E('td', { 'class': 'td', 'title': hist }, m ? (m.ok ? speedText(m.speed) : span(COLOR.bad, m.error || _('failed'))) : '—'),
				E('td', { 'class': 'td' }, (m && m.ok) ? Math.round(m.latency * 1000) + ' ms' : '—'),
				E('td', { 'class': 'td' }, m ? timeAgo(m.time) : '—'),
				E('td', { 'class': 'td' }, (st.mode == 'manual' && usable(l))
					? E('button', { 'class': 'btn cbi-button', 'click': function() { self.chooseLink(l.tag); } }, _('Choose'))
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
			if ((el = document.getElementById('tcl-ov-tor')))     dom.content(el, this.overviewTor());
			if ((el = document.getElementById('tcl-ov-lists')))   dom.content(el, this.overviewLists());
			if ((el = document.getElementById('tcl-ov-measure'))) dom.content(el, this.overviewMeasure());
			if ((el = document.getElementById('tcl-ov-config')))  dom.content(el, this.overviewConfig());
			if ((el = document.getElementById('tcl-clients')))    dom.content(el, this.clientsTable());
			document.querySelectorAll('[data-tcl-links]').forEach(L.bind(function(node) {
				dom.content(node, this.profileLinks(node.getAttribute('data-tcl-links')));
			}, this));
		}, this));
	},

	/* the links of one profile in the profile table */
	profileLinks: function(section_id) {
		var links = this.links().filter(function(l) { return l.profile == section_id; });
		var out = [];
		PROTOCOLS.forEach(function(p) {
			if (!uci.get(CFG, section_id, p)) return;
			var l = links.filter(function(x) { return x.protocol == p; })[0];
			out.push(E('div', {}, [ TITLES[p] + ': ', linkState(l) ]));
		});
		return out.length ? out : span(COLOR.dim, _('no links'));
	},

	/* ---------- actions ---------- */

	chooseLink: function(tag) {
		var el = this.mainSection.getUIElement('main', 'active');
		if (el) { el.setValue(tag); el.triggerValidation(); }
		ui.addTimeLimitedNotification(null, E('p', _('Chosen; click "Save & Apply" to switch.')), 5000, 'info');
	},

	handleMeasure: function(ev) {
		return callMeasure().then(L.bind(function(r) {
			ui.addTimeLimitedNotification(null, E('p', r.running ? _('A measurement is already running.') : _('Measuring every link; the table updates when it is done.')), 5000, 'info');
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
			textModal(_('Generated configuration'), r.config || _('There is no configuration file: the client is off or the settings have not been applied yet.'),
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
		var links = this.links();
		var m, s, o;

		/* Saving a dialog of a table section makes LuCI re-render the whole page from its uci
		   store, so the form's unsaved edits are put into the store before a dialog opens: for a
		   new section before it is created (a store save renames new sections), for "Edit" right
		   before the dialog. */
		var saveBeforeModal = function(sec) {
			sec.handleAdd = function(ev, name) {
				var args = arguments;
				return this.map.save(null, true).catch(function() {}).then(L.bind(function() {
					this.parentSaved = true;
					return form.GridSection.prototype.handleAdd.apply(this, args);
				}, this));
			};
			sec.renderMoreOptionsModal = function(section_id, ev) {
				var args = arguments, saved = this.parentSaved;
				this.parentSaved = false;
				return (saved ? Promise.resolve() : this.map.save(null, true).catch(function() {})).then(L.bind(function() {
					return form.GridSection.prototype.renderMoreOptionsModal.apply(this, args);
				}, this));
			};
		};

		m = new form.Map(CFG, _('Client'),
			_('The devices connected to this router reach the Internet through tunnel clients: a profile holds the links of one server (TCP + XTLS-Vision, XHTTP, Hysteria2, and TCP + XTLS-Vision and XHTTP through Tor, as the server page shows them), every link is a client, and one of them is active, by hand or by the measured speed. The traffic of the LAN is split by a list of domains and subnets; nothing of it bypasses the clients (kill switch) and IPv6 is switched off for the LAN while the client is on. Nothing changes on the router until you click "Save & Apply" or the button that turns the client on or off.'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));
		o = s.option(form.DummyValue, '_ov_service', _('Service'),
			_('The button saves and applies the page like "Save & Apply". On: the LAN reaches the Internet only through this router\'s xray, which intercepts every connection of the LAN devices (TPROXY) and sends it to the active link or directly by the list; the lan → wan forwarding is switched off and IPv6 is switched off for the LAN. If xray stops, the LAN has no Internet (kill switch); ping and other protocols besides TCP and UDP do not leave the LAN meanwhile. Off: everything as before.'));
		o.renderWidget = function() {
			return E('div', {}, [ E('div', { 'id': 'tcl-ov-service' }, self.overviewService()), E('div', { 'style': 'margin-top:.5em' }, self.switchButton()) ]);
		};
		o = s.option(form.DummyValue, '_ov_active', _('Active link'));
		o.renderWidget = function() { return E('span', { 'id': 'tcl-ov-active' }, self.overviewActive()); };
		o = s.option(form.DummyValue, '_ov_tor', _('Tor'));
		o.renderWidget = function() { return E('span', { 'id': 'tcl-ov-tor' }, self.overviewTor()); };
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

		/* Links */
		s = m.section(form.NamedSection, 'main', CFG, _('Links'),
			_('Every link of the profiles below. The speed is a download of the test payload through each link, one link after the other (by default from the server\'s own site through the tunnel, https://127.0.0.1/cgi-bin/speed, served by the site of the Dynamic DNS page of the server router; a profile may name another URL, whose download is cut off after the test size); the latency is the time to the first byte.'));
		o = s.option(form.DummyValue, '_clients', _('Links'));
		o.renderWidget = function() { return E('div', { 'id': 'tcl-clients' }, self.clientsTable()); };

		/* Settings */
		s = m.section(form.NamedSection, 'main', CFG, _('Settings'));
		this.mainSection = s;

		o = s.option(form.ListValue, 'mode', _('Choice of the link'));
		o.value('auto', _('Automatic: the fastest of all links by the measurements'));
		o.value('manual', _('By hand'));
		o.default = 'auto';

		o = s.option(form.ListValue, 'active', _('Active link'), _('Strictly this one; if it fails the LAN waits for it.'));
		if (!links.length) o.value('', _('(no links yet)'));
		links.forEach(function(l) { if (usable(l)) o.value(l.tag, linkLabel(l)); });
		o.depends('mode', 'manual');
		o.retain = true;

		o = s.option(form.Value, 'test_interval', _('Measure every, minutes'), _('In the automatic mode with two links or more: the test download through every link, and the fastest one becomes active. The active link also gets a small request every minute (a HEAD request to its test URL, or one byte from the server\'s site); when it does not answer, the other links get the same request and the one that answers first becomes active. By hand or with one link nothing is measured on its own ("Measure now" still works).'));
		o.datatype = 'range(1,1440)';
		o.placeholder = '60';
		o.rmempty = false;

		o = s.option(form.Value, 'test_bytes', _('Test download, bytes'), _('10 000 to 20 000 000, per link and measurement.'));
		o.datatype = 'range(10000,20000000)';
		o.placeholder = '2000000';
		o.rmempty = false;

		o = s.option(form.Value, 'test_threshold', _('Switch when faster by, %'), _('Automatic mode: another link replaces the active one only when it is faster by at least this much; a failed active link is replaced at once.'));
		o.datatype = 'range(0,1000)';
		o.placeholder = '20';
		o.rmempty = false;

		o = s.option(form.Value, 'test_timeout', _('Test timeout, seconds'));
		o.datatype = 'range(5,300)';
		o.placeholder = '15';
		o.rmempty = false;

		o = s.option(widgets.NetworkSelect, 'metered', _('Metered uplinks'), _('While the router\'s default route goes through one of these interfaces (a mobile modem, for example), the periodic measurement does not run; the measurement after every start of xray and the minute check of the active link stay.'));
		o.multiple = true;
		o.nocreate = true;

		o = s.option(form.Value, 'resolver', _('DNS through the tunnel'),
			_('The resolver asked through the active link for the names that go through the tunnel. The other names are resolved through the provider\'s resolvers as before; the names of the servers themselves always are.'));
		o.datatype = 'ip4addr';
		o.placeholder = '1.1.1.1';
		o.rmempty = false;

		/* The list */
		s = m.section(form.NamedSection, 'main', CFG, _('Split tunnelling'),
			_('Which traffic of the LAN goes through the client. The list holds domains (with their subdomains), subnets, and sources fetched daily.'));

		o = s.option(form.Flag, 'split', _('Split by the list'), _('Off: everything from the LAN goes through the active link.'));
		o.rmempty = false;
		o.default = '1';

		o = s.option(form.ListValue, 'split_mode', _('Through the client goes'));
		o.value('list', _('only what is in the list'));
		o.value('except', _('everything except the list'));
		o.default = 'list';
		o.depends('split', '1');
		o.retain = true;

		o = s.option(form.DynamicList, 'rule', _('Entries'),
			_('A domain (example.com covers its subdomains; names in other alphabets in their punycode form, e.g. xn--p1ai for рф) or a subnet (10.1.2.0/24, a single address as 10.1.2.3).'));
		o.depends('split', '1');
		o.retain = true;
		o.rmempty = true;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim().toLowerCase();
			if (!v) return true;
			if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(v)) return true;
			v = v.replace(/^\*?\./, '');
			return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v) ? true : _('A domain or a subnet');
		};

		s = m.section(form.GridSection, 'source', _('Sources'),
			_('Lists fetched once a day, through the active link when one works: a text file with one domain or IPv4 subnet per line (the v2fly domain-list-community format with include: is understood), or a v2fly .dat file with the kind and the tag of the list inside it. Shipped: the IPv4 networks of Russia (ipverse) and the main Russian services (v2fly category-ru).'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add source…');
		s.modaltitle = function(sid) { return _('Source') + ' » ' + (uci.get(CFG, sid, 'name') || _('new source')); };
		saveBeforeModal(s);
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

		/* Profiles */
		s = m.section(form.GridSection, 'profile', _('Profiles'),
			_('A profile holds the links of one server: one per transport, and with "Through Tor" the links through the onion address of the server with the key of its onion service. Paste them from "Links" next to a profile on the Server page of the server router (the links through Tor and the Tor key are there too).'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add profile…');
		s.modaltitle = function(sid) { return _('Profile') + ' » ' + (uci.get(CFG, sid, 'name') || _('new profile')); };
		saveBeforeModal(s);

		o = s.option(form.Flag, 'enabled', _('Enabled'), _('Switch off to leave out all links of this profile without deleting them.'));
		o.rmempty = false;
		o.default = '1';
		o.editable = true;

		o = s.option(form.Value, 'name', _('Name'), _('The server, for example the router or the VPS it runs on.'));
		o.rmempty = false;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v || v.length > 64) return _('1 to 64 characters');
			var dup = false;
			uci.sections(CFG, 'profile', function(c) {
				if (c['.name'] != section_id && String(c.name || '').toLowerCase() == v.toLowerCase()) dup = true;
			});
			return dup ? _('Another profile has this name') : true;
		};

		var linkCheck = {
			vision: function(v) {
				if (v.indexOf('vless://') != 0) return _('Expected a vless:// link');
				if (/[?&]type=(?!tcp\b|raw\b)/.test(v)) return _('This VLESS link is not over TCP');
				return /[?&]flow=xtls-rprx-vision(&|#|$)/.test(v) ? true : _('The link has no flow=xtls-rprx-vision');
			},
			xhttp: function(v) {
				if (v.indexOf('vless://') != 0) return _('Expected a vless:// link');
				return /[?&]type=(xhttp|splithttp)(&|#|$)/.test(v) ? true : _('This VLESS link is not over XHTTP');
			},
			hysteria2: function(v) {
				return (v.indexOf('hysteria2://') == 0 || v.indexOf('hy2://') == 0) ? true : _('Expected a hysteria2:// link');
			}
		};
		var linkField = function(p, description) {
			o = s.option(form.Value, p, _('%s link').format(TITLES[p]), description);
			o.modalonly = true;
			o.rmempty = true;
			o.placeholder = (p == 'hysteria2') ? 'hysteria2://…' : 'vless://…';
			o.validate = function(section_id, value) {
				var v = String(value || '').trim();
				if (!v) return true;
				var m = /^[a-z0-9]+:\/\/[^@\/?#]*@([^:\/?#]+|\[[0-9a-fA-F:.]+\]):\d+/.exec(v);
				if (!m) return _('A link of the form scheme://…@host:port');
				if (/\.onion$/i.test(m[1])) {
					if (DIRECT.indexOf(p) >= 0) return _('An .onion address is reached only through Tor: this link belongs in the field through Tor');
					if (!/^[a-z2-7]{56}\.onion$/i.test(m[1])) return _('The link needs the 56-character onion address that the server page gives');
				}
				return linkCheck[p.replace('_tor', '')](v);
			};
		};
		DIRECT.forEach(function(p) { linkField(p, _('Empty: no link for this transport.')); });

		o = s.option(form.Flag, 'tor', _('Through Tor'),
			_('The links through Tor go through this router\'s tor (its SOCKS port 127.0.0.1:9050) to the onion address of the server and take part in the choice like the other links. tor runs while they are in use, with the connection settings of XTunnel → Server (section Tor). Tor carries TCP only, so Hysteria2 has no link through Tor. Off: the links through Tor are kept but not used.'));
		o.rmempty = false;
		o.default = '0';
		o.editable = true;

		VIA_TOR.forEach(function(p) { linkField(p, _('The link through Tor from the server page: to its onion address. Empty: none.')); });

		o = s.option(form.Value, 'tor_key', _('Onion service key'),
			_('The line of the Tor key from "Links" of the profile on the Server page of the server router (address:descriptor:x25519:key): its onion service lets in only clients with a key. A new or changed key restarts the tor of this router.'));
		o.modalonly = true;
		o.rmempty = true;
		o.placeholder = '…:descriptor:x25519:…';
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v) return true;
			if (/^[A-Za-z2-7]{56}(\.onion)?:descriptor:x25519:[A-Za-z2-7]{52}$/.test(v) || /^[A-Za-z2-7]{52}$/.test(v)) return true;
			return _('The line of the Tor key: the 56 characters of the address, ":descriptor:x25519:" and the 52 characters of the key');
		};

		o = s.option(form.DummyValue, '_links', _('Links'));
		o.modalonly = false;
		o.editable = true;
		o.renderWidget = function(section_id) {
			return E('div', { 'data-tcl-links': section_id }, self.profileLinks(section_id));
		};

		o = s.option(form.Value, 'test_url', _('URL for the speed test'), _('Empty: https://127.0.0.1/cgi-bin/speed?bytes=… through the tunnel, served by the site of the Dynamic DNS page on the server (with "Access to local networks" on in the server). For other servers: the URL of any file reachable through their links.'));
		o.modalonly = true;
		o.rmempty = true;
		o.placeholder = _('empty = the server\'s own site');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			return (!v || /^https?:\/\/\S+$/.test(v)) ? true : _('http:// or https:// address');
		};

		return m.render().then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 5);
			return nodes;
		}, this));
	}
});
