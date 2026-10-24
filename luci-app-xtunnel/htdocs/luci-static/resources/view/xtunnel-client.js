'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require xtunnel.common as common';

var CFG = 'xtunnel-client';

var callStatus        = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callMeasure       = rpc.declare({ object: CFG, method: 'measure', expect: {} });
var callUpdateSources = rpc.declare({ object: CFG, method: 'update_sources', expect: {} });
var callLog           = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callConfig        = rpc.declare({ object: CFG, method: 'config', expect: {} });
var callRestart       = rpc.declare({ object: CFG, method: 'restart', expect: {} });

var COLOR = common.COLOR, span = common.span, timeAgo = common.timeAgo;
var DIRECT = [ 'vision', 'xhttp', 'hysteria2' ];
var VIA_TOR = [ 'vision_tor', 'xhttp_tor' ];
var PROTOCOLS = DIRECT.concat(VIA_TOR);
var TITLES = { vision: 'TCP + Vision', xhttp: 'XHTTP', hysteria2: 'Hysteria2',
               vision_tor: 'TCP + Vision through Tor', xhttp_tor: 'XHTTP through Tor', tor: 'Tor without a server' };

function speedText(bps) {
	if (!bps) return '—';
	if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
	return Math.round(bps / 1024) + ' KB/s';
}

/* a link that can be chosen: of an enabled profile, through Tor only with "Through Tor" on */
function usable(l) {
	return l.enabled && !l.error && (!l.tor || l.tor_on);
}

function linkLabel(l) {
	if (l.protocol == 'tor') return _('Tor without a server');
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
		return Promise.all([ L.resolveDefault(callStatus(), {}), uci.load('network').catch(function() {}) ]).then(L.bind(function(r) {
			this.status = r[0] || {};
		}, this));
	},

	links: function() {
		return this.status.links || [];
	},

	/* ---------- overview cells ---------- */

	overviewService: function() {
		var st = this.status;
		if (!st.installed)
			return span(COLOR.bad, _('xray is not installed on the router (/usr/bin/xray of the package xtunnel-core, a dependency of this package).'));
		if (!st.enabled)
			return span(COLOR.dim, _('Off: the LAN reaches the Internet as before'));
		if (st.running)
			return span(COLOR.ok, _('Running: the LAN reaches the Internet only through this router\'s xray (interception of the LAN, kill switch), IPv6 is off for the LAN') + (st.version ? ' (Xray ' + st.version + ')' : ''));
		var lines = [ span(COLOR.bad, _('Not running: the LAN has no way to the Internet until it starts (kill switch)')) ];
		if (st.log_last)
			lines.push(E('pre', { 'style': 'color:' + COLOR.dim + '; white-space:pre-wrap; margin:.3em 0 0; font-size:90%' }, st.log_last));
		return E('div', {}, lines);
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
		return common.fileState(st.error, st.enabled && st.config_time, '/etc/xtunnel-client/config.json', st.enabled ? null : _('No configuration file while the client is off'));
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
				E('td', { 'class': 'td' }, l.server_host ? l.server_host + ':' + l.server_port : (l.protocol == 'tor') ? _('exit relays of the Tor network') : '—'),
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
			common.updateRows();
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
		return common.showLog(callLog, _('Log'));
	},

	showConfig: function(ev) {
		return common.showConfig(callConfig, _('Generated configuration'), _('There is no configuration file: the client is off or the settings have not been applied yet.'));
	},

	handleRestart: function(ev) {
		return common.restarted(callRestart, _('xray restarted; connections of the LAN reconnect by themselves.')).then(L.bind(this.refresh, this));
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var st = this.status;
		var links = this.links();
		var m, s, o;

		m = new form.Map(CFG, _('Client'),
			_('The devices connected to this router reach the Internet through tunnel clients: a profile holds the links of one server (TCP + XTLS-Vision, XHTTP, Hysteria2, and TCP + XTLS-Vision and XHTTP through Tor, as the server page shows them), every link is a client, and one of them is active, by hand or by the measured speed. The traffic of the LAN is split by a list of domains and subnets; nothing of it bypasses the clients (kill switch) and IPv6 is switched off for the LAN while the client is on. Nothing changes on the router until you click "Save & Apply" or the button that turns the client on or off.'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));
		o = s.option(form.DummyValue, '_ov_service', _('Service'),
			_('The button saves and applies the page like "Save & Apply". On: the LAN reaches the Internet only through this router\'s xray, which intercepts every connection of the LAN devices (TPROXY) and sends it to the active link or directly by the list; the lan → wan forwarding is switched off and IPv6 is switched off for the LAN. If xray stops, the LAN has no Internet (kill switch); ping and other protocols besides TCP and UDP do not leave the LAN meanwhile. Off: everything as before.'));
		o.renderWidget = function() {
			return E('div', {}, [ E('div', { 'id': 'tcl-ov-service' }, self.overviewService()), E('div', { 'style': 'margin-top:.5em' }, common.switchButton(self, CFG, 'enabled', _('Turn the client on'), _('Turn the client off'))) ]);
		};
		/* while the client is off only what helps to set it up is shown */
		var on = function() { return !!self.status.enabled; };
		common.statusRow(s, '_ov_active', _('Active link'), L.bind(this.overviewActive, this), function() { return on() || !self.links().length; });
		common.statusRow(s, '_ov_tor', _('Tor'), L.bind(this.overviewTor, this), function() { return on() && !!(self.status.tor || {}).used; });
		common.statusRow(s, '_ov_measure', _('Measurement'), L.bind(this.overviewMeasure, this), on);
		common.statusRow(s, '_ov_lists', _('Lists'), L.bind(this.overviewLists, this), on);
		common.statusRow(s, '_ov_config', _('Configuration'), L.bind(this.overviewConfig, this), function() { return on() || !!self.status.error; });
		o = common.shownWhile(s.option(form.DummyValue, '_tools', _('Tools')), '_tools', on);
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
		common.shownWhile(s, '_links', function() { return self.links().length > 0; });
		o = s.option(form.DummyValue, '_clients', _('Links'));
		o.renderWidget = function() { return E('div', { 'id': 'tcl-clients' }, self.clientsTable()); };

		/* Profiles */
		s = m.section(form.GridSection, 'profile', _('Profiles'),
			_('A profile holds the links of one server: one per transport, and with "Through Tor" the links through the onion address of the server with the key of its onion service. Paste them from "Links" next to a profile on the Server page of the server router (the links through Tor and the Tor key are there too; its "Copy all" gives every one of them for "All links at once" in the dialog of the profile).'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add profile…');
		s.modaltitle = function(sid) { return _('Profile') + ' » ' + (uci.get(CFG, sid, 'name') || _('new profile')); };
		common.saveBeforeModal(s);

		/* "Copy all" of the Links dialog on the Server page gives every link and the Tor key at once: they go
		   into the fields of their transports here (not saved as such) */
		o = s.option(form.TextValue, '_paste', _('All links at once'),
			_('Paste what "Copy all" of the Links dialog on the Server page of the server router gives (every link and the Tor key, one per line), then "Fill in the fields".'));
		o.modalonly = true;
		o.rows = 4;
		o.placeholder = 'vless://…\nhysteria2://…\n…:descriptor:x25519:…';
		o.cfgvalue = function() { return ''; };
		o.write = o.remove = function() {};
		o = s.option(form.Button, '_fill', ' ');
		o.modalonly = true;
		o.inputtitle = _('Fill in the fields');
		o.onclick = function(ev, section_id) {
			var sec = this.section, get = function(n) { return sec.getUIElement(section_id, n); };
			var text = String(get('_paste').getValue() || ''), set = {}, name = '';
			text.split(/\s+/).forEach(function(line) {
				var v = line.trim(), m;
				if (!v) return;
				if (/^[a-z2-7]{56}(\.onion)?:descriptor:x25519:[a-z2-7]{52}$/i.test(v)) { set.tor_key = v; return; }
				var p = /^([a-z0-9]+):\/\/[^@\/?#]*@([^:\/?#]+|\[[0-9a-fA-F:.]+\]):\d+/.exec(v);
				if (!p) return;
				var tor = /\.onion$/i.test(p[2]);
				var t = (p[1] == 'hysteria2' || p[1] == 'hy2') ? 'hysteria2'
					: (p[1] != 'vless') ? null : /[?&]type=(xhttp|splithttp)(&|#|$)/.test(v) ? 'xhttp' : 'vision';
				if (!t || (tor && t == 'hysteria2')) return;
				set[tor ? t + '_tor' : t] = v;
				if (!name && (m = /#([^#]+)$/.exec(v))) name = decodeURIComponent(m[1]).replace(/(-xhttp)?(-hysteria2)?(-tor)?$/, '');
			});
			if (!Object.keys(set).length) {
				ui.addTimeLimitedNotification(null, E('p', _('No link and no Tor key found in the text.')), 5000, 'warning');
				return;
			}
			PROTOCOLS.concat([ 'tor_key' ]).forEach(function(n) { var el = get(n); if (el && set[n]) { el.setValue(set[n]); el.triggerValidation(); } });
			if (set.vision_tor || set.xhttp_tor) { var t = get('tor'); if (t) t.setValue('1'); }
			var nm = get('name');
			if (nm && name && !String(nm.getValue() || '').trim()) { nm.setValue(name); nm.triggerValidation(); }
			get('_paste').setValue('');
			ui.addTimeLimitedNotification(null, E('p', _('Filled in: %s.').format(Object.keys(set).map(function(n) { return n == 'tor_key' ? _('the Tor key') : TITLES[n]; }).join(', '))), 5000, 'info');
		};

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

		/* Settings */
		s = m.section(form.NamedSection, 'main', CFG, _('Settings'));
		this.mainSection = s;
		s.tab('choice', _('Choice of the link'));
		s.tab('dns', _('DNS'));
		s.tab('tor', _('Tor without a server'));

		o = s.taboption('choice', form.ListValue, 'mode', _('Choice of the link'));
		o.value('auto', _('Automatic: the fastest of all links by the measurements'));
		o.value('manual', _('By hand'));
		o.default = 'auto';

		o = s.taboption('choice', form.ListValue, 'active', _('Active link'), _('Strictly this one; if it fails the LAN waits for it.'));
		if (!links.length) o.value('', _('(no links yet)'));
		links.forEach(function(l) { if (usable(l)) o.value(l.tag, linkLabel(l)); });
		o.depends('mode', 'manual');
		o.retain = true;

		o = s.taboption('choice', form.Value, 'test_interval', _('Measure every, minutes'), _('In the automatic mode with two links or more: the test download through every link, and the fastest one becomes active. The active link also gets a small request every minute (a HEAD request to its test URL, or one byte from the server\'s site); when it does not answer, the other links get the same request and the one that answers first becomes active. By hand or with one link nothing is measured on its own ("Measure now" still works).'));
		o.datatype = 'range(1,1440)';
		o.placeholder = '60';
		o.rmempty = false;

		o = s.taboption('choice', form.Value, 'test_bytes', _('Test download, bytes'), _('10 000 to 20 000 000, per link and measurement.'));
		o.datatype = 'range(10000,20000000)';
		o.placeholder = '2000000';
		o.rmempty = false;

		o = s.taboption('choice', form.Value, 'test_threshold', _('Switch when faster by, %'), _('Automatic mode: another link replaces the active one only when it is faster by at least this much; a failed active link is replaced at once.'));
		o.datatype = 'range(0,1000)';
		o.placeholder = '20';
		o.rmempty = false;

		o = s.taboption('choice', form.Value, 'test_timeout', _('Test timeout, seconds'));
		o.datatype = 'range(5,300)';
		o.placeholder = '15';
		o.rmempty = false;

		o = s.taboption('choice', form.MultiValue, 'metered', _('Metered uplinks'), _('While the router\'s default route goes through one of these interfaces (a mobile modem, for example), the periodic measurement does not run; the measurement after every start of xray and the minute check of the active link stay.'));
		/* the interfaces of /etc/config/network (widgets.NetworkSelect loads the whole network model) */
		uci.sections('network', 'interface').forEach(function(n) {
			if (n['.name'] != 'loopback') o.value(n['.name'], n['.name']);
		});
		o.display_size = 4;

		o = s.taboption('dns', form.Value, 'resolver', _('DNS through the tunnel'),
			_('The resolver asked through the active link for the names that go through the tunnel. The other names are resolved through the provider\'s resolvers as before; the names of the servers themselves always are.'));
		o.datatype = 'ip4addr';
		o.placeholder = '1.1.1.1';
		o.rmempty = false;

		o = s.taboption('tor', form.Flag, 'tor_exit', _('Enabled'),
			_('One more link, "Tor without a server": the LAN through the Tor network and out of its exit relays, with this router\'s tor, when no server is at hand. It takes part in the choice like the other links (in the automatic mode it becomes active when it is the fastest, in practice when the servers do not answer). Tor carries TCP only: UDP (QUIC, calls, games) does not pass, and the resolver above is asked over TCP while the link is on.'));
		o.rmempty = false;
		o.default = '0';

		o = s.taboption('tor', form.Value, 'tor_test_url', _('URL for the speed test through Tor'),
			_('What the link "Tor without a server" is measured and checked with, through Tor and out of an exit relay. Empty: cgi-bin/speed of this router\'s own site at its domain (the site of the Dynamic DNS page), https://<domain>/cgi-bin/speed?bytes=20000000. When a router in front forwards another public port to the site, or for another of your sites, enter the URL.'));
		o.placeholder = _('empty = this router\'s own site');
		o.rmempty = true;
		o.retain = true;
		o.depends('tor_exit', '1');
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			return (!v || /^https?:\/\/\S+$/.test(v)) ? true : _('http:// or https:// address');
		};

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
		common.saveBeforeModal(s);
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

		return m.render().then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 5);
			return nodes;
		}, this));
	}
});
