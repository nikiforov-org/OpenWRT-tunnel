'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require uqr';

var CFG = 'tunnel-tailscale';

var callStatus  = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callLogin   = rpc.declare({ object: CFG, method: 'login_link', expect: {} });
var callLogout  = rpc.declare({ object: CFG, method: 'logout', expect: {} });
var callLog     = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callRestart = rpc.declare({ object: CFG, method: 'restart', expect: {} });

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };

function span(color, text) {
	return E('span', { 'style': color ? 'color:' + color : '' }, text);
}

function seenAgo(iso) {
	if (!iso || iso.indexOf('0001-01-01') == 0) return '';
	var t = Date.parse(iso);
	if (isNaN(t)) return '';
	var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
	if (s < 90)     return _('just now');
	if (s < 5400)   return _('%d minutes ago').format(Math.round(s / 60));
	if (s < 172800) return _('%d hours ago').format(Math.round(s / 3600));
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

function textModal(title, text) {
	ui.showModal(title, [
		E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 24, 'readonly': 'readonly' }, text),
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
	]);
}

return view.extend({
	status: {},

	load: function() {
		return L.resolveDefault(callStatus(), {}).then(L.bind(function(st) { this.status = st || {}; }, this));
	},

	/* ---------- overview ---------- */

	overviewService: function() {
		var st = this.status;
		if (!st.installed) return span(COLOR.bad, _('The tailscale package is not installed. It is a dependency of this package: run "apk update && apk add tailscale".'));
		if (!st.enabled) return span(COLOR.dim, _('Off — tick "Run Tailscale" below and click "Save & Apply"'));
		if (!st.running) return span(COLOR.bad, _('Not running'));
		if (st.state == 'Running')
			return E('span', {}, [ span(COLOR.ok, _('Connected')), st.version ? E('span', { 'style': 'color:' + COLOR.dim }, ' (Tailscale ' + st.version + ')') : '' ]);
		if (st.state == 'NeedsLogin' || st.state == 'NoState')
			return span(COLOR.warn, _('Not logged in — enter an auth key below and click "Save & Apply", or use "Get login link"'));
		return span(COLOR.warn, st.state || _('Starting…'));
	},

	overviewAddress: function() {
		var st = this.status;
		if (st.state != 'Running') return span(COLOR.dim, '—');
		return E('span', {}, [
			st.ipv4 ? E('code', {}, st.ipv4) : '',
			st.dns_name ? E('span', {}, [ ' ', E('code', {}, st.dns_name) ]) : '',
			st.tailnet ? E('span', { 'style': 'color:' + COLOR.dim }, ' — ' + _('tailnet') + ' ' + st.tailnet) : ''
		]);
	},

	overviewExit: function() {
		var st = this.status;
		if (st.state != 'Running') return span(COLOR.dim, '—');
		var parts = [];
		if (st.exit_node_advertised)
			parts.push(st.exit_node_approved ? span(COLOR.ok, _('Exit node: offered and approved')) : span(COLOR.warn, _('Exit node: offered, waiting for approval in the Tailscale admin console')));
		else
			parts.push(span(COLOR.dim, _('Exit node: not offered')));
		var routes = st.routes_approved || [];
		parts.push(E('div', {}, routes.length ? span(COLOR.ok, _('Subnet routes approved: %s').format(routes.join(', '))) : span(COLOR.dim, _('No subnet route approved yet (offered routes are approved in the admin console)'))));
		return E('div', {}, parts);
	},

	overviewAccess: function() {
		var st = this.status;
		if (!st.zone) return span(COLOR.dim, _('No firewall zone — the router is not reachable from the tailnet'));
		return span(COLOR.ok, st.local_access
			? _('Devices of the tailnet reach the Internet through this router, the router itself and its LAN (firewall zone "tunnel_tailscale")')
			: _('Devices of the tailnet reach the Internet through this router; the router and its LAN are closed (firewall zone "tunnel_tailscale")'));
	},

	overviewLogin: function() {
		var st = this.status;
		if (!st.running) return span(COLOR.dim, '—');
		if (st.state == 'Running')
			return E('span', {}, [ span(COLOR.ok, _('Logged in as %s').format(st.hostname || '?')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-remove', 'click': ui.createHandlerFn(this, 'handleLogout') }, _('Log out')) ]);
		if (st.state == 'NeedsLogin' || st.state == 'NoState')
			return E('span', {}, [ st.error ? span(COLOR.warn, st.error) : span(COLOR.warn, _('Login needed')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, 'handleLoginLink') }, _('Get login link')) ]);
		return span(COLOR.dim, st.state);
	},

	overviewConfig: function() {
		var st = this.status;
		if (!st.enabled) return span(COLOR.dim, _('Off'));
		if (st.error && (st.state == 'NeedsLogin' || st.state == 'NoState')) return span(COLOR.warn, _('Waiting for the login; applied right after it'));
		if (st.error) return span(COLOR.bad, _('Not applied: %s').format(st.error));
		return span(COLOR.ok, _('Applied'));
	},

	peersTable: function() {
		var peers = this.status.peers || [];
		var rows = peers.map(function(p) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, span(p.online ? COLOR.ok : COLOR.dim, p.online ? _('online') : _('offline'))),
				E('td', { 'class': 'td' }, [ p.hostname, p.exit_node ? E('span', { 'style': 'color:' + COLOR.dim }, ' (' + _('exit node') + ')') : '' ]),
				E('td', { 'class': 'td' }, E('code', {}, p.ip)),
				E('td', { 'class': 'td' }, p.os),
				E('td', { 'class': 'td' }, p.online ? '' : seenAgo(p.last_seen))
			]);
		});
		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, ''), E('th', { 'class': 'th' }, _('Device')), E('th', { 'class': 'th' }, _('Tailscale IP')),
				E('th', { 'class': 'th' }, _('OS')), E('th', { 'class': 'th' }, _('Last seen'))
			])
		].concat(rows.length ? rows : [ E('tr', { 'class': 'tr' }, E('td', { 'class': 'td', 'colspan': 5 }, span(COLOR.dim, this.status.state == 'Running' ? _('No other devices in the tailnet.') : _('Not logged in.')))) ]));
	},

	refresh: function() {
		return L.resolveDefault(callStatus(), null).then(L.bind(function(st) {
			if (!st) return;
			this.status = st;
			var el;
			if ((el = document.getElementById('tts-ov-service'))) dom.content(el, this.overviewService());
			if ((el = document.getElementById('tts-ov-address'))) dom.content(el, this.overviewAddress());
			if ((el = document.getElementById('tts-ov-exit')))    dom.content(el, this.overviewExit());
			if ((el = document.getElementById('tts-ov-access')))  dom.content(el, this.overviewAccess());
			if ((el = document.getElementById('tts-ov-login')))   dom.content(el, this.overviewLogin());
			if ((el = document.getElementById('tts-ov-config')))  dom.content(el, this.overviewConfig());
			if ((el = document.getElementById('tts-peers')))      dom.content(el, this.peersTable());
		}, this));
	},

	/* ---------- actions ---------- */

	handleLoginLink: function(ev) {
		return callLogin().then(L.bind(function(r) {
			if (r.error) { ui.addNotification(null, E('p', r.error), 'error'); return; }
			var svg = null;
			try { svg = uqr.renderSVG(r.url, { pixelSize: 5 }); } catch (e) {}
			ui.showModal(_('Log in to Tailscale'), [
				E('p', _('Open this link in a browser where you are logged in to your Tailscale account (or scan the code with a phone) and approve the router. The link stays valid for 15 minutes; after the login the settings are applied by themselves.')),
				E('p', { 'style': 'text-align:center' }, [ E('a', { 'href': r.url, 'target': '_blank' }, r.url), ' ',
					E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(r.url); } }, _('Copy')) ]),
				E('div', { 'style': 'margin:1em auto; width:240px' }, svg ? Object.assign(E(svg), { style: 'width:100%; height:auto' }) : ''),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
			]);
		}, this));
	},

	handleLogout: function(ev) {
		if (!confirm(_('Log this router out of the tailnet? Its devices lose the connection until it is logged in again (an auth key or a new login link).')))
			return;
		return callLogout().then(L.bind(function(r) {
			if (!r.ok) ui.addNotification(null, E('p', r.log || _('Logout failed.')), 'error');
			else ui.addTimeLimitedNotification(null, E('p', _('Logged out.')), 5000, 'info');
			return this.refresh();
		}, this));
	},

	showLog: function(ev) {
		return callLog().then(function(r) { textModal(_('Tailscale log'), r.log || _('The log is empty.')); });
	},

	handleRestart: function(ev) {
		return callRestart().then(L.bind(function(r) {
			if (!r.ok) ui.addNotification(null, E('p', r.log || _('Restart failed.')), 'error');
			else ui.addTimeLimitedNotification(null, E('p', _('Tailscale restarted.')), 5000, 'info');
			return this.refresh();
		}, this));
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var m, s, o;

		m = new form.Map(CFG, _('Tailscale'),
			_('This router as a device of your tailnet: it offers itself as an exit node and as the router of its LAN, so that the other devices of the tailnet reach the Internet and the LAN through it. The devices and their access are managed in the Tailscale admin console. Nothing changes on the router until you click "Save & Apply".'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));

		o = s.option(form.DummyValue, '_ov_service', _('Service'));
		o.renderWidget = function() { return E('span', { 'id': 'tts-ov-service' }, self.overviewService()); };

		o = s.option(form.DummyValue, '_ov_login', _('Login'));
		o.renderWidget = function() { return E('span', { 'id': 'tts-ov-login' }, self.overviewLogin()); };

		o = s.option(form.DummyValue, '_ov_address', _('Address in the tailnet'));
		o.renderWidget = function() { return E('span', { 'id': 'tts-ov-address' }, self.overviewAddress()); };

		o = s.option(form.DummyValue, '_ov_exit', _('Exit node and routes'));
		o.renderWidget = function() { return E('span', { 'id': 'tts-ov-exit' }, self.overviewExit()); };

		o = s.option(form.DummyValue, '_ov_access', _('Access through the router'));
		o.renderWidget = function() { return E('span', { 'id': 'tts-ov-access' }, self.overviewAccess()); };

		o = s.option(form.DummyValue, '_ov_config', _('Settings'));
		o.renderWidget = function() { return E('span', { 'id': 'tts-ov-config' }, self.overviewConfig()); };

		o = s.option(form.DummyValue, '_tools', _('Tools'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showLog') }, _('Show log')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleRestart') }, _('Restart Tailscale'))
			]);
		};

		/* Settings */
		s = m.section(form.NamedSection, 'main', CFG, _('Settings'));

		o = s.option(form.Flag, 'enabled', _('Run Tailscale'),
			_('Starts the Tailscale service, applies the settings below and adds the firewall zone "tunnel_tailscale" for the tailscale0 interface. Switch off to disconnect (the login is kept) and remove the zone.'));
		o.rmempty = false;

		o = s.option(form.Value, 'auth_key', _('Auth key'),
			_('A key from the Tailscale admin console (Settings → Keys), used to log the router in on "Save & Apply". A reusable key keeps working after a reflash. Without a key use "Get login link" in the overview.'));
		o.rmempty = true;

		o = s.option(form.Value, 'hostname', _('Device name'), _('The router\'s name in the tailnet. Empty: the router\'s hostname.'));
		o.rmempty = true;
		o.datatype = 'hostname';

		o = s.option(form.Flag, 'advertise_exit_node', _('Offer as exit node'),
			_('Devices of the tailnet may send all their Internet traffic through this router, once the exit node is approved in the admin console.'));
		o.rmempty = false;
		o.default = '1';

		o = s.option(form.DynamicList, 'advertise_routes', _('Offer routes to'),
			_('Subnets behind this router that devices of the tailnet may reach, once approved in the admin console. Empty: the router\'s LAN subnet.'));
		o.datatype = 'cidr4';
		o.rmempty = true;
		o.placeholder = '192.168.1.0/24';

		o = s.option(form.Flag, 'accept_routes', _('Accept routes of other devices'), _('Use subnet routes offered by other devices of the tailnet.'));
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.Flag, 'accept_dns', _('Use the tailnet DNS'), _('Use MagicDNS and the DNS settings of the tailnet on this router.'));
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.Flag, 'ssh', _('Tailscale SSH'), _('Allow SSH to this router through Tailscale, with the tailnet\'s access rules.'));
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.Flag, 'shields_up', _('Shields up'), _('Block all incoming connections from the tailnet to this router.'));
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.Flag, 'local_access', _('Access to the router and its LAN'),
			_('Devices of the tailnet may reach this router (its administration included) and the networks behind it. Off: only the Internet through this router.'));
		o.rmempty = false;
		o.default = '1';

		/* Devices */
		s = m.section(form.NamedSection, 'main', CFG, _('Devices of the tailnet'));
		o = s.option(form.DummyValue, '_peers', _('Devices'));
		o.renderWidget = function() { return E('div', { 'id': 'tts-peers' }, self.peersTable()); };

		return m.render().then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 5);
			return nodes;
		}, this));
	}
});
