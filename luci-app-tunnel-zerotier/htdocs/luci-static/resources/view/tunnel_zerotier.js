'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';
'require uqr';

var CFG = 'tunnel_zerotier';

var callStatus   = rpc.declare({ object: CFG, method: 'status', expect: {} });
var callCentral  = rpc.declare({ object: CFG, method: 'central_networks', expect: {} });
var callMembers  = rpc.declare({ object: CFG, method: 'members', params: [ 'nwid' ], expect: {} });
var callSetMember = rpc.declare({ object: CFG, method: 'set_member', params: [ 'nwid', 'node_id', 'authorized', 'ip', 'name' ], expect: {} });
var callDelMember = rpc.declare({ object: CFG, method: 'del_member', params: [ 'nwid', 'node_id' ], expect: {} });
var callRoutes   = rpc.declare({ object: CFG, method: 'routes', params: [ 'nwid' ], expect: {} });
var callSetRoutes = rpc.declare({ object: CFG, method: 'set_routes', params: [ 'nwid', 'routes' ], expect: {} });
var callCreate   = rpc.declare({ object: CFG, method: 'create_network', params: [ 'name' ], expect: {} });
var callDelNet   = rpc.declare({ object: CFG, method: 'del_network', params: [ 'nwid' ], expect: {} });
var callAuthSelf = rpc.declare({ object: CFG, method: 'authorize_self', params: [ 'nwid' ], expect: {} });
var callLog      = rpc.declare({ object: CFG, method: 'log', expect: {} });
var callRestart  = rpc.declare({ object: CFG, method: 'restart', expect: {} });

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };
var NWID_RE = /^[0-9a-f]{16}$/;

function span(color, text) {
	return E('span', { 'style': color ? 'color:' + color : '' }, text);
}

function seenAgo(ms) {
	if (!ms) return _('never');
	var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
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

function notifyResult(r, okText) {
	if (r && r.error)
		ui.addNotification(null, E('p', r.error), 'error');
	else if (okText)
		ui.addTimeLimitedNotification(null, E('p', okText), 5000, 'info');
	return !(r && r.error);
}

function showQr(nwid, name) {
	var svg = null;
	try { svg = uqr.renderSVG(nwid, { pixelSize: 6 }); } catch (e) {}
	ui.showModal(_('Join network') + ' — ' + (name || nwid), [
		E('p', _('Scan the code in the ZeroTier app ("Add network") or copy the network ID:')),
		E('p', { 'style': 'text-align:center' }, [ E('code', { 'style': 'font-size:120%' }, nwid), ' ',
			E('button', { 'class': 'btn cbi-button', 'click': function() { return copyText(nwid); } }, _('Copy')) ]),
		E('div', { 'style': 'margin:1em auto; width:240px' }, svg ? Object.assign(E(svg), { style: 'width:100%; height:auto' }) : span(COLOR.dim, _('QR code unavailable'))),
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
	]);
}

function textModal(title, text) {
	ui.showModal(title, [
		E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 24, 'readonly': 'readonly' }, text),
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
	]);
}

return view.extend({
	status: {},
	central: null,        /* { networks: [] } or { error } */
	selected: '',         /* network managed in the Members / Routes tables */
	members: [],
	membersRemoved: [],
	routes: [],

	load: function() {
		return Promise.all([ L.resolveDefault(callStatus(), {}), L.resolveDefault(callCentral(), { error: _('no answer') }) ]).then(L.bind(function(res) {
			this.status = res[0] || {};
			this.central = res[1] || {};
			var first = (this.status.networks || []).filter(function(n) { return n.enabled; })[0] || (this.central.networks || [])[0];
			this.selected = first ? first.id : '';
		}, this));
	},

	/* ---------- overview ---------- */

	overviewNode: function() {
		var st = this.status;
		if (!st.installed) return span(COLOR.bad, _('The zerotier package is not installed. It is a dependency of this package: run "apk update && apk add zerotier".'));
		if (!st.enabled) return span(COLOR.dim, _('Off — tick "Run ZeroTier" below and click "Save & Apply"'));
		if (!st.running) return span(COLOR.bad, _('Not running'));
		return E('span', {}, [
			span(st.online ? COLOR.ok : COLOR.warn, st.online ? _('Online') : _('Running, not connected to the ZeroTier network yet')),
			st.node_id ? E('span', { 'style': 'color:' + COLOR.dim }, ' — ' + _('node ID') + ' ') : '',
			st.node_id ? E('code', {}, st.node_id) : '',
			st.version ? E('span', { 'style': 'color:' + COLOR.dim }, ' (ZeroTier ' + st.version + ')') : ''
		]);
	},

	overviewAccess: function() {
		var st = this.status;
		if (!st.zone) return span(COLOR.dim, _('No firewall zone — the router is not reachable from the ZeroTier networks'));
		return span(COLOR.ok, st.local_access
			? _('Members of the networks reach the Internet through this router, the router itself and its LAN (firewall zone "tunnel_zerotier")')
			: _('Members of the networks reach the Internet through this router; the router and its LAN are closed (firewall zone "tunnel_zerotier")'));
	},

	overviewConfig: function() {
		var st = this.status;
		if (st.error) return span(COLOR.bad, _('Not applied: %s').format(st.error));
		if (!st.has_token) return span(COLOR.warn, _('No API token: the networks of the account, their members and routes cannot be managed from this page'));
		if (this.central && this.central.error) return span(COLOR.warn, _('Central: %s').format(this.central.error));
		return span(COLOR.ok, _('Connected to ZeroTier Central (%d networks in the account)').format((this.central.networks || []).length));
	},

	networkCell: function(sid) {
		var n = (this.status.networks || []).filter(function(x) { return x.sid == sid; })[0];
		if (!n) return span(COLOR.dim, _('Save & Apply to join'));
		if (!n.enabled) return span(COLOR.dim, _('Disabled'));
		if (!this.status.running) return span(COLOR.dim, _('ZeroTier is not running'));
		if (!n.joined) return span(COLOR.warn, _('Not joined yet'));
		if (n.status == 'OK')
			return E('span', {}, [ span(COLOR.ok, _('Member') + ' ✔'), n.ip ? E('span', { 'style': 'color:' + COLOR.dim }, ' — ' + n.ip + (n.iface ? ' (' + n.iface + ')' : '')) : '' ]);
		if (n.status == 'ACCESS_DENIED')
			return span(COLOR.warn, _('Waiting for authorization in Central'));
		return span(COLOR.warn, n.status || _('Joining…'));
	},

	refresh: function() {
		return L.resolveDefault(callStatus(), null).then(L.bind(function(st) {
			if (!st) return;
			this.status = st;
			var el;
			if ((el = document.getElementById('tzt-ov-node')))   dom.content(el, this.overviewNode());
			if ((el = document.getElementById('tzt-ov-access'))) dom.content(el, this.overviewAccess());
			if ((el = document.getElementById('tzt-ov-config'))) dom.content(el, this.overviewConfig());
			document.querySelectorAll('[data-tzt-net]').forEach(L.bind(function(n) { dom.content(n, this.networkCell(n.getAttribute('data-tzt-net'))); }, this));
		}, this));
	},

	/* ---------- actions ---------- */

	handleAuthorize: function(nwid, ev) {
		return callAuthSelf(nwid || '').then(L.bind(function(r) {
			if (notifyResult(r, _('This router (node %s) is authorized in %s.').format(r.node_id, (r.networks || []).join(', '))))
				return this.refresh();
		}, this));
	},

	showLog: function(ev) {
		return callLog().then(function(r) { textModal(_('ZeroTier log'), r.log || _('The log is empty.')); });
	},

	handleRestart: function(ev) {
		return callRestart().then(L.bind(function(r) {
			notifyResult(r.ok ? r : { error: r.log || _('Restart failed.') }, _('ZeroTier restarted.'));
			return this.refresh();
		}, this));
	},

	/* add a network of the account to this router's list (saved with Save & Apply) */
	handleAddFromCentral: function(nwid, name, ev) {
		var exists = false;
		uci.sections(CFG, 'network', function(s) { if (s.id == nwid) exists = true; });
		if (exists) { ui.addNotification(null, E('p', _('%s is already in the list below.').format(nwid)), 'warning'); return; }
		return this.map.save(null, true).catch(function() {}).then(L.bind(function() {
			var sid = uci.add(CFG, 'network');
			uci.set(CFG, sid, 'id', nwid);
			uci.set(CFG, sid, 'enabled', '1');
			if (name) uci.set(CFG, sid, 'name', name);
			return this.map.reset();
		}, this)).then(function() {
			ui.addTimeLimitedNotification(null, E('p', _('Network %s added to the list. Click "Save & Apply" to join it.').format(nwid)), 6000, 'info');
		});
	},

	handleCreate: function(ev) {
		var input = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%', 'placeholder': _('name') });
		ui.showModal(_('Create a network in the account'), [
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Name')), E('div', { 'class': 'cbi-value-field' }, input) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-positive important', 'click': ui.createHandlerFn(this, function() {
					return callCreate(input.value).then(L.bind(function(r) {
						ui.hideModal();
						if (notifyResult(r, _('Network %s created.').format(r.id)))
							return this.reloadCentral();
					}, this));
				}) }, _('Create'))
			])
		]);
		input.focus();
	},

	handleDeleteNetwork: function(nwid, name, ev) {
		if (!confirm(_('Delete network %s (%s) from the account? All its members lose it. This cannot be undone.').format(nwid, name || '')))
			return;
		return callDelNet(nwid).then(L.bind(function(r) {
			if (notifyResult(r, _('Network %s deleted.').format(nwid)))
				return this.reloadCentral();
		}, this));
	},

	reloadCentral: function() {
		return L.resolveDefault(callCentral(), { error: _('no answer') }).then(L.bind(function(c) {
			this.central = c || {};
			var el = document.getElementById('tzt-central');
			if (el) dom.content(el, this.centralTable());
			if ((el = document.getElementById('tzt-ov-config'))) dom.content(el, this.overviewConfig());
			this.renderSelector();
		}, this));
	},

	/* ---------- the account's networks ---------- */

	centralTable: function() {
		var self = this, c = this.central || {};
		if (!this.status.has_token) return span(COLOR.dim, _('Enter the API token above and click "Save & Apply" to see the networks of the account.'));
		if (c.error) return span(COLOR.warn, c.error);
		var mine = {};
		(this.status.networks || []).forEach(function(n) { mine[n.id] = n; });
		var rows = (c.networks || []).map(function(n) {
			var m = mine[n.id];
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ E('code', {}, n.id), ' ', E('button', { 'class': 'btn cbi-button', 'title': _('Copy the network ID'), 'click': function() { return copyText(n.id); } }, _('Copy')) ]),
				E('td', { 'class': 'td' }, n.name || ''),
				E('td', { 'class': 'td' }, n.online + ' / ' + n.members),
				E('td', { 'class': 'td' }, (n.routes || []).join(', ') || span(COLOR.dim, _('none'))),
				E('td', { 'class': 'td' }, m ? span(COLOR.ok, m.joined && m.status == 'OK' ? _('member') + (m.ip ? ', ' + m.ip : '') : _('in the list below')) : span(COLOR.dim, _('no'))),
				E('td', { 'class': 'td right', 'style': 'white-space:nowrap' }, [
					E('button', { 'class': 'btn cbi-button', 'click': function() { showQr(n.id, n.name); } }, _('QR')), ' ',
					m ? '' : E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleAddFromCentral', n.id, n.name) }, _('Add to this router')),
					m ? '' : ' ',
					E('button', { 'class': 'btn cbi-button cbi-button-remove', 'click': ui.createHandlerFn(self, 'handleDeleteNetwork', n.id, n.name) }, _('Delete'))
				])
			]);
		});
		return E('div', {}, [
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Network ID')), E('th', { 'class': 'th' }, _('Name')), E('th', { 'class': 'th' }, _('Online / members')),
					E('th', { 'class': 'th' }, _('Routes')), E('th', { 'class': 'th' }, _('This router')), E('th', { 'class': 'th' }, '')
				])
			].concat(rows.length ? rows : [ E('tr', { 'class': 'tr' }, E('td', { 'class': 'td', 'colspan': 6 }, span(COLOR.dim, _('No networks in the account yet.')))) ])),
			E('div', { 'style': 'margin-top:.6em' }, E('button', { 'class': 'btn cbi-button cbi-button-add', 'click': ui.createHandlerFn(this, 'handleCreate') }, _('Create a network…')))
		]);
	},

	/* ---------- members and routes of the selected network ---------- */

	selectorOptions: function() {
		var seen = {}, out = [];
		(this.status.networks || []).forEach(function(n) { if (n.id && !seen[n.id]) { seen[n.id] = true; out.push({ id: n.id, name: n.name || n.central_name }); } });
		((this.central || {}).networks || []).forEach(function(n) { if (!seen[n.id]) { seen[n.id] = true; out.push({ id: n.id, name: n.name }); } });
		return out;
	},

	renderSelector: function() {
		var el = document.getElementById('tzt-select');
		if (!el) return;
		var opts = this.selectorOptions();
		dom.content(el, opts.length ? E('select', { 'class': 'cbi-input-select', 'change': L.bind(function(ev) { this.selected = ev.target.value; this.loadTables(); }, this) },
			opts.map(L.bind(function(o) { var e = E('option', { 'value': o.id }, (o.name ? o.name + ' — ' : '') + o.id); if (o.id == this.selected) e.selected = true; return e; }, this)))
			: span(COLOR.dim, _('no networks')));
	},

	loadTables: function() {
		var nwid = this.selected;
		var mEl = document.getElementById('tzt-members'), rEl = document.getElementById('tzt-routes');
		if (!nwid || !this.status.has_token) {
			if (mEl) dom.content(mEl, span(COLOR.dim, _('Select a network above; an API token is needed.')));
			if (rEl) dom.content(rEl, span(COLOR.dim, _('Select a network above; an API token is needed.')));
			return Promise.resolve();
		}
		return Promise.all([ L.resolveDefault(callMembers(nwid), { error: _('no answer') }), L.resolveDefault(callRoutes(nwid), { error: _('no answer') }) ]).then(L.bind(function(res) {
			this.members = res[0].error ? null : (res[0].members || []);
			this.membersRemoved = [];
			this.routes = res[1].error ? null : (res[1].routes || []);
			if (mEl) dom.content(mEl, this.members ? this.membersTable() : span(COLOR.warn, res[0].error));
			if (rEl) dom.content(rEl, this.routes ? this.routesTable() : span(COLOR.warn, res[1].error));
		}, this));
	},

	syncMembersFromDom: function() {
		this.members.forEach(function(m) {
			var row = document.getElementById('tzt-m-' + m.node_id);
			if (!row) return;
			m.name = row.querySelector('[data-k=name]').value.trim();
			m.authorized = row.querySelector('[data-k=auth]').checked;
			m.ip = row.querySelector('[data-k=ip]').value.trim();
		});
	},

	membersTable: function() {
		var self = this, myNode = this.status.node_id;
		var rows = this.members.map(function(m) {
			return E('tr', { 'class': 'tr', 'id': 'tzt-m-' + m.node_id }, [
				E('td', { 'class': 'td' }, E('input', { 'class': 'cbi-input-text', 'style': 'width:95%', 'value': m.name, 'data-k': 'name' })),
				E('td', { 'class': 'td' }, [ E('code', {}, m.node_id), m.node_id == myNode ? E('span', { 'style': 'color:' + COLOR.dim }, ' ' + _('(this router)')) : '' ]),
				E('td', { 'class': 'td', 'style': 'text-align:center' }, (function() { var c = E('input', { 'type': 'checkbox', 'data-k': 'auth' }); c.checked = m.authorized; return c; })()),
				E('td', { 'class': 'td' }, E('input', { 'class': 'cbi-input-text', 'style': 'width:95%', 'value': m.ip, 'data-k': 'ip', 'placeholder': _('automatic') })),
				E('td', { 'class': 'td' }, [ span(m.online ? COLOR.ok : COLOR.dim, m.online ? _('online') : _('offline')), ' ', E('span', { 'style': 'color:' + COLOR.dim }, seenAgo(m.last_seen)) ]),
				E('td', { 'class': 'td right' }, E('button', { 'class': 'btn cbi-button cbi-button-remove', 'click': function() {
					self.syncMembersFromDom();
					self.membersRemoved.push(m.node_id);
					self.members = self.members.filter(function(x) { return x.node_id != m.node_id; });
					dom.content(document.getElementById('tzt-members'), self.membersTable());
				} }, _('Remove')))
			]);
		});
		return E('div', {}, [
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Name')), E('th', { 'class': 'th' }, _('Node ID')), E('th', { 'class': 'th' }, _('Authorized')),
					E('th', { 'class': 'th' }, _('IP address')), E('th', { 'class': 'th' }, _('Last seen')), E('th', { 'class': 'th' }, '')
				])
			].concat(rows.length ? rows : [ E('tr', { 'class': 'tr' }, E('td', { 'class': 'td', 'colspan': 6 }, span(COLOR.dim, _('No members yet.')))) ])),
			this.membersRemoved.length ? E('p', { 'style': 'color:' + COLOR.warn }, _('%d member(s) will be removed when you save.').format(this.membersRemoved.length)) : '',
			E('div', { 'style': 'margin-top:.6em' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-positive', 'click': ui.createHandlerFn(this, 'saveMembers') }, _('Save members')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'loadTables') }, _('Reload'))
			])
		]);
	},

	saveMembers: function(ev) {
		this.syncMembersFromDom();
		var nwid = this.selected, chain = Promise.resolve({ ok: true }), failed = null;
		this.members.forEach(function(m) {
			chain = chain.then(function(r) { if (r && r.error) return r; return callSetMember(nwid, m.node_id, m.authorized ? '1' : '0', m.ip, m.name); });
		});
		this.membersRemoved.forEach(function(id) {
			chain = chain.then(function(r) { if (r && r.error) return r; return callDelMember(nwid, id); });
		});
		return chain.then(L.bind(function(r) {
			if (notifyResult(r, _('Members saved.')))
				return this.loadTables().then(L.bind(this.refresh, this));
		}, this));
	},

	routesTable: function() {
		var self = this;
		var mine = (this.status.networks || []).filter(function(n) { return n.id == self.selected; })[0];
		var myIp = mine ? mine.ip : '';
		var hasExit = this.routes.some(function(r) { return r.target == '0.0.0.0/0'; });
		var rows = this.routes.map(function(r, i) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('code', {}, r.target)),
				E('td', { 'class': 'td' }, r.via ? E('code', {}, r.via) : span(COLOR.dim, _('(direct, within the network)'))),
				E('td', { 'class': 'td right' }, E('button', { 'class': 'btn cbi-button cbi-button-remove', 'click': function() { self.routes.splice(i, 1); dom.content(document.getElementById('tzt-routes'), self.routesTable()); } }, _('Remove')))
			]);
		});
		var exitBox = E('input', { 'type': 'checkbox', 'change': function(ev) {
			self.routes = self.routes.filter(function(r) { return r.target != '0.0.0.0/0'; });
			if (ev.target.checked && myIp) self.routes.push({ target: '0.0.0.0/0', via: myIp });
			dom.content(document.getElementById('tzt-routes'), self.routesTable());
		} });
		exitBox.checked = hasExit;
		if (!myIp) exitBox.disabled = true;
		var target = E('input', { 'class': 'cbi-input-text', 'style': 'width:12em', 'placeholder': '192.168.1.0/24' });
		var via = E('input', { 'class': 'cbi-input-text', 'style': 'width:12em', 'placeholder': _('gateway, empty = direct') });
		return E('div', {}, [
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Exit through this router')),
				E('div', { 'class': 'cbi-value-field' }, [ exitBox, ' ', myIp
					? _('Members send all their Internet traffic through this router (route 0.0.0.0/0 via %s). Each member also has to allow the default route in its ZeroTier app.').format(myIp)
					: span(COLOR.dim, _('This router is not a member of this network yet, or has no IP address in it yet.')) ])
			]),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th' }, _('Target')), E('th', { 'class': 'th' }, _('Via')), E('th', { 'class': 'th' }, '') ])
			].concat(rows.length ? rows : [ E('tr', { 'class': 'tr' }, E('td', { 'class': 'td', 'colspan': 3 }, span(COLOR.dim, _('No routes.')))) ])),
			E('div', { 'style': 'margin-top:.6em' }, [ target, ' ', via, ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-add', 'click': function() {
					var t = target.value.trim();
					if (!/^[0-9a-fA-F.:]+\/[0-9]+$/.test(t)) { ui.addNotification(null, E('p', _('Enter the target as a network with prefix, for example 192.168.1.0/24.')), 'warning'); return; }
					self.routes.push({ target: t, via: via.value.trim() });
					dom.content(document.getElementById('tzt-routes'), self.routesTable());
				} }, _('Add route'))
			]),
			E('div', { 'style': 'margin-top:.6em' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-positive', 'click': ui.createHandlerFn(this, 'saveRoutes') }, _('Save routes')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'loadTables') }, _('Reload'))
			])
		]);
	},

	saveRoutes: function(ev) {
		return callSetRoutes(this.selected, this.routes).then(L.bind(function(r) {
			if (notifyResult(r, _('Routes saved.')))
				return this.loadTables().then(L.bind(this.reloadCentral, this));
		}, this));
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var st = this.status;
		var m, s, o;

		m = new form.Map(CFG, _('ZeroTier'),
			_('This router as a member of your ZeroTier networks: it joins the networks listed here, members of those networks reach the Internet, the router and its LAN through it, and with an API token the networks of the ZeroTier Central account, their members and routes are managed on this page. Nothing changes on the router until you click "Save & Apply".'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', CFG, _('Overview'));

		o = s.option(form.DummyValue, '_ov_node', _('Node'));
		o.renderWidget = function() { return E('span', { 'id': 'tzt-ov-node' }, self.overviewNode()); };

		o = s.option(form.DummyValue, '_ov_access', _('Access through the router'));
		o.renderWidget = function() { return E('span', { 'id': 'tzt-ov-access' }, self.overviewAccess()); };

		o = s.option(form.DummyValue, '_ov_config', _('ZeroTier Central'));
		o.renderWidget = function() { return E('span', { 'id': 'tzt-ov-config' }, self.overviewConfig()); };

		o = s.option(form.DummyValue, '_tools', _('Tools'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'showLog') }, _('Show log')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleRestart') }, _('Restart ZeroTier')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleAuthorize', '') }, _('Authorize this router in its networks'))
			]);
		};

		/* Settings */
		s = m.section(form.NamedSection, 'main', CFG, _('Settings'));

		o = s.option(form.Flag, 'enabled', _('Run ZeroTier'),
			_('Starts the ZeroTier service, joins the networks listed below and adds the firewall zone "tunnel_zerotier" for the ZeroTier interfaces. Switch off to leave the networks and remove the zone; the settings stay.'));
		o.rmempty = false;

		o = s.option(form.Value, 'api_token', _('API token'),
			_('A token of your ZeroTier Central account (Account → API Access Tokens). Stored on the router; it is used to list the networks of the account, manage members and routes, and authorize this router in the networks it joins.'));
		o.rmempty = true;

		o = s.option(form.Flag, 'local_access', _('Access to the router and its LAN'),
			_('Members of the networks may reach this router (its administration included) and the networks behind it. Off: only the Internet through this router.'));
		o.rmempty = false;
		o.default = '1';

		/* Networks this router joins */
		s = m.section(form.GridSection, 'network', _('Networks this router joins'),
			_('Each entry is a ZeroTier network the router is a member of. With an API token the router is authorized in them automatically on "Save & Apply"; otherwise authorize it in Central.'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add network…');
		s.modaltitle = function(sid) { return _('Network') + ' » ' + (uci.get(CFG, sid, 'name') || uci.get(CFG, sid, 'id') || _('new network')); };

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
			var nwid = uci.get(CFG, section_id, 'id') || '';
			dom.content(tdEl.lastChild, [
				E('button', { 'class': 'btn cbi-button', 'title': _('QR code with the network ID for the ZeroTier app'), 'click': function() { showQr(nwid, uci.get(CFG, section_id, 'name')); } }, _('QR')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'title': _('Authorize this router in the network through Central'), 'click': ui.createHandlerFn(self, 'handleAuthorize', nwid) }, _('Authorize')), ' '
			].concat(existing));
			return tdEl;
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'), _('Switch off to leave the network without deleting the entry.'));
		o.rmempty = false;
		o.default = '1';
		o.editable = true;

		o = s.option(form.Value, 'id', _('Network ID'), _('16 hexadecimal characters, from the network page in ZeroTier Central.'));
		o.rmempty = false;
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!NWID_RE.test(v)) return _('Enter the 16-character network ID (0-9, a-f)');
			var dup = false;
			uci.sections(CFG, 'network', function(n) { if (n['.name'] != section_id && n.id == v) dup = true; });
			return dup ? _('This network is already in the list') : true;
		};

		o = s.option(form.Value, 'name', _('Name'), _('A label for this list; optional.'));
		o.rmempty = true;

		o = s.option(form.DummyValue, '_state', _('State'));
		o.modalonly = false;
		o.textvalue = function(sid) { return E('div', { 'data-tzt-net': sid }, self.networkCell(sid)); };

		/* The account */
		s = m.section(form.NamedSection, 'main', CFG, _('Networks of the account'),
			_('Everything in this section talks to ZeroTier Central directly and takes effect at once; it needs the API token.'));

		o = s.option(form.DummyValue, '_central', _('Networks'));
		o.renderWidget = function() { return E('div', { 'id': 'tzt-central' }, self.centralTable()); };

		o = s.option(form.DummyValue, '_select', _('Manage network'));
		o.renderWidget = function() { var d = E('div', { 'id': 'tzt-select' }); window.setTimeout(function() { self.renderSelector(); self.loadTables(); }, 0); return d; };

		o = s.option(form.DummyValue, '_members', _('Members'));
		o.renderWidget = function() { return E('div', { 'id': 'tzt-members' }, span(COLOR.dim, '…')); };

		o = s.option(form.DummyValue, '_routes', _('Routes'));
		o.renderWidget = function() { return E('div', { 'id': 'tzt-routes' }, span(COLOR.dim, '…')); };

		return m.render().then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 10);
			return nodes;
		}, this));
	}
});
