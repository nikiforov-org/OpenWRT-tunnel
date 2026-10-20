'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';

var callStatus      = rpc.declare({ object: 'tunnel-ddns', method: 'status', expect: {} });
var callDdnsUpdate  = rpc.declare({ object: 'tunnel-ddns', method: 'ddns_update', params: [ 'section' ], expect: {} });
var callDdnsLog     = rpc.declare({ object: 'tunnel-ddns', method: 'ddns_log', params: [ 'section' ], expect: {} });
var callCertIssue   = rpc.declare({ object: 'tunnel-ddns', method: 'cert_issue', params: [ 'section' ], expect: {} });
var callCertLog     = rpc.declare({ object: 'tunnel-ddns', method: 'cert_log', params: [ 'section' ], expect: {} });
var callSiteInstall = rpc.declare({ object: 'tunnel-ddns', method: 'site_install', params: [ 'name', 'replace' ], expect: {} });
var callSiteDelete  = rpc.declare({ object: 'tunnel-ddns', method: 'site_delete', params: [ 'name' ], expect: {} });
var callSiteRebuild    = rpc.declare({ object: 'tunnel-ddns', method: 'site_rebuild', params: [ 'name' ], expect: {} });
var callSiteRebuildLog = rpc.declare({ object: 'tunnel-ddns', method: 'site_rebuild_log', params: [ 'name' ], expect: {} });
var callSetPort        = rpc.declare({ object: 'tunnel-ddns', method: 'set_port', params: [ 'port' ], expect: {} });
var callRevert      = rpc.declare({ object: 'tunnel-ddns', method: 'revert', expect: {} });

var UPLOAD_PATH = '/tmp/tunnel-ddns-upload.tar.gz';

var PROVIDERS = [
	[ 'duckdns',    'DuckDNS (duckdns.org)' ],
	[ 'dynv6',      'dynv6 (dynv6.com)' ],
	[ 'ipv64',      'IPv64 (ipv64.net)' ],
	[ 'dnsexit',    'DNSExit (dnsexit.com)' ],
	[ 'mydnsjp',    'MyDNS.JP (mydns.jp)' ],
	[ 'beget',      'Beget (beget.com)' ],
	[ 'cloudflare', 'Cloudflare (cloudflare.com)' ]
];

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };

function span(color, text) {
	return E('span', { 'style': color ? 'color:' + color : '' }, text);
}

function timeAgo(ts) {
	if (!ts) return null;
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

function siteName(fileName) {
	return String(fileName || '').replace(/\.(tar\.gz|tgz)$/i, '').toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').substring(0, 32);
}

return view.extend({
	status: {},

	load: function() {
		return L.resolveDefault(callStatus(), {}).then(L.bind(function(st) {
			this.status = st || {};
		}, this));
	},

	/* ---------- status cells ---------- */

	ddnsCell: function(sid) {
		var d = (this.status.domains || {})[sid];
		var lines = [];
		if (!d)
			return span(COLOR.dim, _('Save & Apply to activate'));
		if (!d.enabled)
			return span(COLOR.dim, _('Disabled'));
		var ip = this.status.public_ip || '';
		var resolved = d.resolved ? d.resolved.split(',') : [];
		if (resolved.length && ip && resolved.indexOf(ip) >= 0)
			lines.push(span(COLOR.ok, _('Points to this router') + ' ✔'));
		else if (resolved.length)
			lines.push(span(COLOR.warn, _('Points to %s').format(resolved.join(', '))));
		else
			lines.push(span(COLOR.warn, _('Name does not resolve yet')));
		if (d.ddns.last_update)
			lines.push(E('div', { 'style': 'color:' + COLOR.dim }, _('Updated %s').format(timeAgo(d.ddns.last_update))));
		else
			lines.push(E('div', { 'style': 'color:' + COLOR.dim }, d.ddns.running ? _('Updater running, no update sent yet') : _('Updater not running')));
		return E('div', {}, lines);
	},

	certCell: function(sid) {
		var d = (this.status.domains || {})[sid];
		if (!d)
			return span(COLOR.dim, '—');
		var job = d.job, lines = [];
		if (job && job.state == 'running')
			return span(COLOR.warn, _('Issuing… (%s)').format(timeAgo(job.ts) || ''));
		if (d.cert && !d.cert.error) {
			var n = daysLeft(d.cert.not_after);
			var col = (d.cert.valid && n != null && n > 14) ? COLOR.ok : COLOR.bad;
			if (n != null && n <= 30 && n > 14) col = COLOR.warn;
			lines.push(span(col, n != null ? _('Valid, %d days left').format(n) : _('Valid until %s').format(d.cert.not_after)));
			if (d.cert.staging)
				lines.push(E('div', { 'style': 'color:' + COLOR.warn }, _('Test certificate (not trusted by browsers)')));
		}
		else {
			lines.push(span(COLOR.dim, _('Not issued yet')));
		}
		if (job && job.state == 'failed')
			lines.push(E('div', { 'style': 'color:' + COLOR.bad }, _('Last attempt failed — see the log')));
		return E('div', {}, lines);
	},

	overviewSite: function() {
		var m = this.status.main || {};
		if (!m.site_enabled)
			return span(COLOR.dim, _('Off — the router shows its administration pages'));
		if (!m.serving)
			return span(COLOR.warn, _('Switching on…'));
		var host = m.site_hostname;
		return E('span', {}, [
			span(COLOR.ok, _('Serving site "%s"').format(m.site)),
			host ? E('span', {}, [ ' — ', E('a', { 'href': 'https://' + host + '/', 'target': '_blank' }, 'https://' + host + '/') ]) : ' — ' + _('no domain selected'),
			m.uhttpd_cert && m.uhttpd_cert.indexOf('/etc/ssl/tunnel-ddns/') == 0 ? '' : E('div', { 'style': 'color:' + COLOR.warn }, _('Using the router\'s own self-signed certificate until a Let\'s Encrypt certificate is issued for the selected domain'))
		]);
	},

	overviewAccess: function() {
		var m = this.status.main || {};
		if (m.xray_front)
			return span(COLOR.ok, _('Port %s is served by the Xray server in front of the site (its firewall rule); the site answers behind it on 127.0.0.1:%s for every visitor that is not an Xray client').format(m.site_port || '443', m.behind_port || '4443'));
		return m.firewall_rule
			? span(COLOR.ok, _('Port %s is open from the Internet (firewall rule "tunnel-ddns: HTTPS from WAN")').format(m.site_port || '443'))
			: span(COLOR.dim, _('Closed — no port is open from the Internet'));
	},

	overviewRenewal: function() {
		var m = this.status.main || {};
		return m.cron
			? span(COLOR.ok, _('Checked nightly; certificates are renewed 30 days before they expire'))
			: span(COLOR.dim, _('Not scheduled yet — it starts after the first certificate is issued'));
	},

	overviewContent: function() {
		var m = this.status.main || {};
		if (!m.site_has_build) return span(COLOR.dim, _('Static — the page does not change on its own'));
		var sched;
		if (!m.site_schedule) sched = span(COLOR.dim, _('rebuilt only by the button'));
		else if (m.site_scheduled) sched = span(COLOR.dim, _('rebuilt on schedule "%s"').format(m.site_schedule));
		else sched = span(COLOR.bad, _('the schedule "%s" is not a valid cron time, correct it below').format(m.site_schedule));
		var b = m.site_build, col = COLOR.ok, state = _('not built yet');
		if (b && b.state == 'running') { col = COLOR.warn; state = _('rebuilding now'); }
		else if (b && b.state == 'failed') { col = COLOR.bad; state = _('last rebuild failed'); }
		else if (b && b.ts) { state = _('last rebuilt %s').format(timeAgo(b.ts)); }
		return E('span', {}, [ span(col, state), ' — ', sched ]);
	},

	overviewLogin: function() {
		var m = this.status.main || {};
		if (!m.site_enabled || !m.site_has_login)
			return span(COLOR.dim, _('The standard LuCI login page'));
		if (!m.login_replaced)
			return span(COLOR.warn, _('The site brings its own login page; it takes over after "Save & Apply"'));
		return span(COLOR.ok, _('The site\'s login page (/cgi-bin/login) replaces the LuCI login page; the direct JSON-RPC endpoint is off while the site is served'));
	},

	refresh: function() {
		return L.resolveDefault(callStatus(), null).then(L.bind(function(st) {
			if (!st) return;
			this.status = st;
			var el;
			if ((el = document.getElementById('tdd-ov-ip')))      dom.content(el, this.status.public_ip || span(COLOR.warn, _('Could not detect')));
			if ((el = document.getElementById('tdd-ov-site')))    dom.content(el, this.overviewSite());
			if ((el = document.getElementById('tdd-ov-access')))  dom.content(el, this.overviewAccess());
			if ((el = document.getElementById('tdd-ov-renewal'))) dom.content(el, this.overviewRenewal());
			if ((el = document.getElementById('tdd-ov-content'))) dom.content(el, this.overviewContent());
			if ((el = document.getElementById('tdd-ov-login')))   dom.content(el, this.overviewLogin());
			document.querySelectorAll('[data-tdd-ddns]').forEach(L.bind(function(n) { dom.content(n, this.ddnsCell(n.getAttribute('data-tdd-ddns'))); }, this));
			document.querySelectorAll('[data-tdd-cert]').forEach(L.bind(function(n) { dom.content(n, this.certCell(n.getAttribute('data-tdd-cert'))); }, this));
		}, this));
	},

	/* ---------- actions ---------- */

	/* LuCI remembers per session which RPC endpoint answered first. When the site's login page
	   takes over, the direct endpoint (/ubus) goes away, so before such an apply LuCI is pointed
	   at its own fallback through cgi-bin/luci; otherwise the reloaded page could not talk to
	   the router any more. */
	handleSaveApply: function(ev, mode) {
		return this.map.save(null, true).then(L.bind(function() {
			var enabled = (uci.get('tunnel-ddns', 'main', 'site_enabled') == '1');
			var site = uci.get('tunnel-ddns', 'main', 'site');
			var withLogin = (this.status.sites || []).some(function(s) { return s.name == site && s.has_login; });
			if (enabled && withLogin) {
				try {
					var key = 'luci-session-store', sid = L.env.sessionid;
					var store = JSON.parse(window.sessionStorage.getItem(key) || '{}');
					store[sid] = store[sid] || {};
					store[sid].rpcBaseURL = L.url('admin/ubus');
					window.sessionStorage.setItem(key, JSON.stringify(store));
				} catch (e) {}
			}
			return this.super('handleSaveApply', [ ev, mode ]);
		}, this));
	},

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

	handleDdnsUpdate: function(sid, ev) {
		return this.ensureSaved().then(L.bind(function(ok) {
			if (!ok) return;
			return callDdnsUpdate(sid).then(L.bind(function(r) {
				if (r.error)
					ui.addNotification(null, E('p', r.error), 'error');
				else
					ui.addTimeLimitedNotification(null, E('p', _('Address update started. The status refreshes automatically.')), 6000, 'info');
				return this.refresh();
			}, this));
		}, this));
	},

	handleCertIssue: function(sid, ev) {
		return this.ensureSaved().then(L.bind(function(ok) {
			if (!ok) return;
			return callCertIssue(sid).then(L.bind(function(r) {
				if (r.error)
					ui.addNotification(null, E('p', r.error), 'error');
				else if (r.already)
					ui.addTimeLimitedNotification(null, E('p', _('A certificate request for this domain is already in progress.')), 6000, 'info');
				else
					ui.addTimeLimitedNotification(null, E('p', _('Certificate request started. It usually takes one to three minutes; the status refreshes automatically.')), 8000, 'info');
				return this.refresh();
			}, this));
		}, this));
	},

	showLog: function(fetch, sid, title) {
		return fetch(sid).then(function(r) {
			ui.showModal(title, [
				E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 24, 'readonly': 'readonly' }, r.log || _('The log is empty.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close'))
				])
			]);
		});
	},

	handleChangePort: function(ev) {
		var cur = (this.status.main || {}).site_port || '443';
		var input = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:8em', 'value': cur });
		ui.showModal(_('HTTPS port'), [
			E('p', _('The site and the router admin are served on this port. Changing it restarts the web server, so if you are connected through it you will need to reconnect at the new port.')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Port')),
				E('div', { 'class': 'cbi-value-field' }, input)
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action important', 'click': ui.createHandlerFn(this, function() {
					var port = String(input.value).trim();
					return callSetPort(port).then(L.bind(function(r) {
						if (r.error) { ui.addNotification(null, E('p', r.error), 'error'); return; }
						var url = 'https://' + window.location.hostname + ':' + r.port + '/cgi-bin/luci/';
						ui.showModal(_('Port changed'), [
							E('p', _('The web server is moving to port %s. If the admin was served on the old port, reconnect here in a few seconds:').format(r.port)),
							E('p', {}, E('a', { 'href': url }, url)),
							E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
						]);
					}, this));
				}) }, _('Change port'))
			])
		]);
	},

	handleSiteRebuild: function(ev) {
		return callSiteRebuild('').then(L.bind(function(r) {
			if (r.error)
				ui.addNotification(null, E('p', r.error), 'error');
			else if (r.already)
				ui.addTimeLimitedNotification(null, E('p', _('A rebuild is already running.')), 5000, 'info');
			else
				ui.addTimeLimitedNotification(null, E('p', _('Rebuild started. It fetches the latest content; the page updates in a minute or two.')), 7000, 'info');
			return this.refresh();
		}, this));
	},

	showSiteLog: function(ev) {
		return callSiteRebuildLog('').then(function(r) {
			ui.showModal(_('Site rebuild log'), [
				E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 24, 'readonly': 'readonly' }, r.log || _('No rebuild has run yet.')),
				E('div', { 'class': 'right' }, [ E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')) ])
			]);
		});
	},

	handleRevert: function(ev) {
		ui.showModal(_('Switch everything off?'), [
			E('p', _('Dynamic DNS updates stop, the HTTPS port is closed, the router\'s web server returns to its administration pages with the standard login, and the certificate renewal and content rebuild jobs are removed. Certificates, uploaded sites and all settings are kept, so everything can be switched on again later.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, function() {
					return callRevert().then(function(r) {
						ui.hideModal();
						if (r.error)
							ui.addNotification(null, E('p', r.error), 'error');
						else
							window.setTimeout(function() { window.location.reload(); }, 300);
					});
				}) }, _('Switch off'))
			])
		]);
	},

	/* ---------- sites ---------- */

	sitesTable: function() {
		var sites = this.status.sites || [];
		var active = (this.status.main || {}).site;
		var rows = sites.map(L.bind(function(st) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [
					E('strong', {}, st.name),
					st.builtin ? E('span', { 'style': 'color:' + COLOR.dim }, ' ' + _('(built-in)')) : '',
					st.name == active ? E('span', { 'style': 'color:' + COLOR.ok }, ' ' + _('(selected)')) : '',
					st.has_index ? '' : E('span', { 'style': 'color:' + COLOR.bad }, ' ' + _('(index.html is missing)')),
					st.has_build ? E('div', { 'style': 'color:' + COLOR.dim }, _('builds its own content')) : '',
					st.has_login ? E('div', { 'style': 'color:' + COLOR.dim }, _('brings a login page for the router admin')) : ''
				]),
				E('td', { 'class': 'td' }, '%1024mB'.format(st.size_kb * 1024)),
				E('td', { 'class': 'td right' }, st.builtin ? '' : E('button', {
					'class': 'btn cbi-button cbi-button-remove',
					'click': ui.createHandlerFn(this, 'handleSiteDelete', st.name)
				}, _('Delete')))
			]);
		}, this));
		var free = (this.status.main || {}).overlay_free_kb;
		return E('div', { 'id': 'tdd-sites' }, [
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Name')),
					E('th', { 'class': 'th' }, _('Size')),
					E('th', { 'class': 'th' }, '')
				])
			].concat(rows)),
			E('div', { 'style': 'margin-top:.6em; display:flex; align-items:center; gap:1em; flex-wrap:wrap' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, 'handleUpload') }, _('Upload a site archive…')),
				free != null ? E('span', { 'style': 'color:' + COLOR.dim }, _('%s free on the router').format('%1024mB'.format(free * 1024))) : ''
			])
		]);
	},

	refreshSites: function() {
		return this.refresh().then(L.bind(function() {
			var old = document.getElementById('tdd-sites');
			if (old) old.parentNode.replaceChild(this.sitesTable(), old);
			var sel = document.getElementById('widget.cbid.tunnel-ddns.main.site');
			if (sel && sel.tagName == 'SELECT') {
				var names = (this.status.sites || []).map(function(s) { return s.name; });
				var current = sel.value;
				while (sel.options.length) sel.remove(0);
				names.forEach(function(n) { sel.add(new Option(n == 'default' ? n + ' ' + _('(built-in)') : n, n)); });
				sel.value = names.indexOf(current) >= 0 ? current : ((this.status.main || {}).site || 'default');
			}
		}, this));
	},

	handleSiteDelete: function(name, ev) {
		if (!confirm(_('Delete site "%s"? This cannot be undone.').format(name)))
			return;
		return callSiteDelete(name).then(L.bind(function(r) {
			if (r.error)
				ui.addNotification(null, E('p', r.error), 'error');
			else {
				ui.addTimeLimitedNotification(null, E('p', r.switched_to_default
					? _('Site "%s" deleted. The built-in site is selected now.').format(name)
					: _('Site "%s" deleted.').format(name)), 5000, 'info');
				window.setTimeout(function() { window.location.reload(); }, 1200);
			}
		}, this));
	},

	installSite: function(name, replace) {
		return callSiteInstall(name, replace).then(L.bind(function(r) {
			if (r.exists) {
				if (confirm(_('A site named "%s" already exists. Replace it?').format(name)))
					return this.installSite(name, true);
				return;
			}
			if (r.error) {
				ui.addNotification(null, E('p', r.error), 'error');
				return;
			}
			ui.addTimeLimitedNotification(null, E('p', (r.has_build ? _('Site "%s" uploaded; its first build has started.') : _('Site "%s" uploaded.')).format(r.name) + ' ' + _('The page reloads so you can select it below.')), 5000, 'info');
			window.setTimeout(function() { window.location.reload(); }, 1200);
		}, this));
	},

	handleUpload: function(ev) {
		return ui.uploadFile(UPLOAD_PATH).then(L.bind(function(reply) {
			var suggested = siteName(reply && reply.name) || 'site';
			var input = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%', 'value': suggested });
			ui.showModal(_('Name of the site'), [
				E('p', _('Lowercase letters, digits, dots, dashes and underscores. The site will be stored in /usr/share/www/<name>/.')),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Name')),
					E('div', { 'class': 'cbi-value-field' }, input)
				]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
					E('button', { 'class': 'btn cbi-button cbi-button-positive important', 'click': ui.createHandlerFn(this, function() {
						var name = siteName(input.value + '.tar.gz');
						if (!name) { input.focus(); return; }
						ui.hideModal();
						return this.installSite(name, false);
					}) }, _('Install'))
				])
			]);
			input.focus();
		}, this)).catch(function(e) {
			if (e && e.message && e.message.indexOf('cancelled') < 0)
				ui.addNotification(null, E('p', String(e.message)), 'error');
		});
	},

	/* ---------- page ---------- */

	render: function() {
		var self = this;
		var st = this.status;
		var m, s, o;

		m = new form.Map('tunnel-ddns', _('Dynamic DNS, certificates and web site'),
			_('Keeps your domain names pointed at this router, gets a Let\'s Encrypt certificate for each of them and can serve your own web site over HTTPS. Nothing changes on the router until you click "Save & Apply".'));
		this.map = m;

		/* Overview */
		s = m.section(form.NamedSection, 'main', 'tunnel-ddns', _('Overview'));

		o = s.option(form.DummyValue, '_ov_ip', _('Public IP address'));
		o.renderWidget = function() { return E('span', { 'id': 'tdd-ov-ip' }, st.public_ip || span(COLOR.warn, _('Could not detect'))); };

		o = s.option(form.DummyValue, '_ov_site', _('Web site'));
		o.renderWidget = function() { return E('span', { 'id': 'tdd-ov-site' }, self.overviewSite()); };

		if (st.main && st.main.site_has_build) {
			o = s.option(form.DummyValue, '_ov_content', _('Content'));
			o.renderWidget = function() { return E('span', { 'id': 'tdd-ov-content' }, self.overviewContent()); };
		}

		o = s.option(form.DummyValue, '_ov_login', _('Admin login'));
		o.renderWidget = function() { return E('span', { 'id': 'tdd-ov-login' }, self.overviewLogin()); };

		o = s.option(form.DummyValue, '_ov_access', _('Access from the Internet'));
		o.renderWidget = function() { return E('span', { 'id': 'tdd-ov-access' }, self.overviewAccess()); };

		o = s.option(form.DummyValue, '_ov_renewal', _('Certificate renewal'));
		o.renderWidget = function() { return E('span', { 'id': 'tdd-ov-renewal' }, self.overviewRenewal()); };

		/* Domains */
		s = m.section(form.GridSection, 'domain', _('Domains'),
			_('Each domain is kept pointed at this router\'s public IP address and gets its own Let\'s Encrypt certificate. Add a domain, enter the login details of its provider, click "Save & Apply", then "Issue certificate".'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add domain…');
		s.modaltitle = function(sid) {
			return _('Domain') + ' » ' + (uci.get('tunnel-ddns', sid, 'hostname') || _('new domain'));
		};
		s.tab('general', _('Settings'));
		s.tab('logs', _('Logs'));

		s.renderRowActions = function(section_id) {
			var tdEl = this.super('renderRowActions', [ section_id, _('Edit') ]);
			var existing = [].slice.call(tdEl.lastChild.childNodes);
			dom.content(tdEl.lastChild, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'title': _('Send the current public IP address to the provider now'),
					'click': ui.createHandlerFn(self, 'handleDdnsUpdate', section_id)
				}, _('Update address')), ' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'title': _('Issue or renew the Let\'s Encrypt certificate for this domain'),
					'click': ui.createHandlerFn(self, 'handleCertIssue', section_id)
				}, _('Issue certificate')), ' '
			].concat(existing));
			return tdEl;
		};

		o = s.taboption('general', form.Flag, 'enabled', _('Enabled'),
			_('Keep this domain pointed at the router. Switch off to pause updates without deleting the settings.'));
		o.rmempty = false;
		o.default = '1';
		o.editable = true;

		o = s.taboption('general', form.Value, 'hostname', _('Hostname'),
			_('The full name registered at the provider, for example myname.duckdns.org or www.example.org.'));
		o.rmempty = false;
		o.datatype = 'hostname';
		o.placeholder = 'myname.duckdns.org';

		o = s.taboption('general', form.ListValue, 'provider', _('Provider'),
			_('Where the domain is registered. The login details below depend on the provider.'));
		PROVIDERS.forEach(function(p) { o.value(p[0], p[1]); });
		o.rmempty = false;
		o.textvalue = function(sid) {
			var v = this.cfgvalue(sid);
			for (var i = 0; i < PROVIDERS.length; i++)
				if (PROVIDERS[i][0] == v) return PROVIDERS[i][1];
			return v || '';
		};

		function cred(opt, provider, title, desc) {
			var f = s.taboption('general', form.Value, opt, title, desc);
			f.modalonly = true;
			f.rmempty = false;
			f.depends('provider', provider);
			return f;
		}
		cred('duckdns_token', 'duckdns', _('Token'),
			_('Shown on your DuckDNS account page. Used both to update the address and to prove ownership of the domain for the certificate.'));
		cred('dynv6_token', 'dynv6', _('HTTP token'),
			_('Create it at dynv6.com → Keys. Used both to update the address and for the certificate.'));
		cred('ipv64_ddns_key', 'ipv64', _('Dynamic DNS key'),
			_('The "DynDNS updater key" from ipv64.net → Account. Used to update the address.'));
		cred('ipv64_api_key', 'ipv64', _('API key'),
			_('The "API key" from ipv64.net → Account. Used for the certificate.'));
		cred('dnsexit_user', 'dnsexit', _('Login'), _('Your DNSExit account name.'));
		cred('dnsexit_password', 'dnsexit', _('Password'), _('Your DNSExit account password.'));
		cred('dnsexit_api_key', 'dnsexit', _('API key'),
			_('Generate it at dnsexit.com → Settings → DNS API Key. Used for the certificate.'));
		cred('mydnsjp_master_id', 'mydnsjp', _('Master ID'), _('The MasterID from the MyDNS.JP registration e-mail.'));
		cred('mydnsjp_password', 'mydnsjp', _('Password'), _('The password from the MyDNS.JP registration e-mail.'));
		cred('beget_login', 'beget', _('Login'), _('Your Beget account login.'));
		cred('beget_api_password', 'beget', _('API password'),
			_('Set in the Beget control panel under Account settings → Access restriction, with the "DNS" group enabled. This is not the control panel password.'));
		cred('cf_token', 'cloudflare', _('API token'),
			_('Create it at Cloudflare → My Profile → API Tokens with the permission "Zone → DNS → Edit" for this zone.'));
		cred('cf_zone_id', 'cloudflare', _('Zone ID'),
			_('Shown on the overview page of the zone in the Cloudflare dashboard.'));

		o = s.taboption('general', form.Flag, 'staging', _('Use the Let\'s Encrypt test server'),
			_('Issues a test certificate that browsers do not trust. Useful to check the setup without hitting the Let\'s Encrypt limits. Switch it off and issue again to get a real certificate.'));
		o.modalonly = true;
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.DummyValue, '_ddns', _('Dynamic DNS'));
		o.modalonly = false;
		o.textvalue = function(sid) { return E('div', { 'data-tdd-ddns': sid }, self.ddnsCell(sid)); };

		o = s.option(form.DummyValue, '_cert', _('Certificate'));
		o.modalonly = false;
		o.textvalue = function(sid) { return E('div', { 'data-tdd-cert': sid }, self.certCell(sid)); };

		o = s.taboption('logs', form.Button, '_ddns_log', _('Dynamic DNS log'),
			_('Messages of the address updater for this domain.'));
		o.modalonly = true;
		o.inputtitle = _('Show log');
		o.onclick = function(ev, sid) { return self.showLog(callDdnsLog, sid, _('Dynamic DNS log')); };

		o = s.taboption('logs', form.Button, '_cert_log', _('Certificate log'),
			_('Output of the last certificate request for this domain.'));
		o.modalonly = true;
		o.inputtitle = _('Show log');
		o.onclick = function(ev, sid) { return self.showLog(callCertLog, sid, _('Certificate log')); };

		/* Web site */
		s = m.section(form.NamedSection, 'main', 'tunnel-ddns', _('Web site'),
			_('Serve your own pages instead of the router\'s administration pages. Upload a site as a .tar.gz archive, pick the domain it should answer to and switch it on. A site may bring a build script (.tunnel-ddns/build) that regenerates its pages, and a login page (cgi-bin/login) that replaces the LuCI login.'));

		o = s.option(form.Flag, 'site_enabled', _('Serve the web site'),
			_('Switches the router\'s web server to the selected site on all of its ports and opens the HTTPS port below from the Internet (firewall rule "tunnel-ddns: HTTPS from WAN"). The administration pages stay available at /cgi-bin/luci/.'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'site_domain', _('Domain'),
			_('The site answers to this domain name and uses its certificate.'));
		o.value('', _('— choose a domain —'));
		Object.keys(st.domains || {}).forEach(function(sid) {
			var d = st.domains[sid];
			o.value(sid, d.hostname || sid);
		});
		o.rmempty = true;

		o = s.option(form.ListValue, 'site', _('Site'),
			_('Which of the uploaded sites to serve.'));
		(st.sites || []).forEach(function(site) {
			o.value(site.name, site.builtin ? site.name + ' ' + _('(built-in)') : site.name);
		});
		o.default = 'default';

		o = s.option(form.DummyValue, '_site_port', _('HTTPS port'),
			_('Port the site and the router admin (/cgi-bin/luci/) are served on. The usual choice is 443. When the Xray server of this router runs on the same port, it takes the port and the site is served behind it on 127.0.0.1:4443; visitors still get the site on this port.'));
		o.renderWidget = function() {
			return E('span', {}, [
				E('strong', { 'style': 'margin-right:1em' }, (st.main && st.main.site_port) || '443'),
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleChangePort') }, _('Change…'))
			]);
		};

		o = s.option(form.DummyValue, '_sites', _('Uploaded sites'),
			_('A .tar.gz archive with index.html at its top level (or inside a single folder). Sites are stored in /usr/share/www/ on the router; a build script and its files go to /etc/tunnel-ddns/sites/.'));
		o.renderWidget = function() { return self.sitesTable(); };

		if (st.main && st.main.site_has_build) {
			o = s.option(form.Value, 'site_schedule', _('Rebuild schedule'),
				_('When the router runs the build script of the selected site, as a cron time: minute, hour, day of month, month, day of week. For example "0 3 * * *" is every night at 03:00 and "0 */6 * * *" every six hours. Leave empty to rebuild only by the button.'));
			o.placeholder = '0 3 * * *';
			o.rmempty = true;
			o.validate = function(section_id, value) {
				var fields = String(value || '').trim().split(/\s+/);
				if (fields[0] === '') return true;
				if (fields.length != 5 || !fields.every(function(f) { return /^[0-9*,\/-]+$/.test(f); }))
					return _('Enter five cron fields, for example 0 3 * * *');
				return true;
			};

			o = s.option(form.Button, '_rebuild', _('Rebuild now'),
				_('Fetch the latest content and regenerate the page immediately.'));
			o.inputtitle = _('Rebuild now');
			o.inputstyle = 'apply';
			o.onclick = L.bind(this.handleSiteRebuild, this);

			o = s.option(form.Button, '_rebuild_log', _('Rebuild log'),
				_('Output of the last content rebuild.'));
			o.inputtitle = _('Show log');
			o.onclick = L.bind(this.showSiteLog, this);
		}

		o = s.option(form.Value, 'ip_url', _('Public IP detection'),
			_('A web page that returns the router\'s public IPv4 address as plain text. Used by the address updater.'));
		o.rmempty = false;
		o.placeholder = 'https://ipv4-internet.yandex.net/api/v0/ip';

		/* Switch off */
		s = m.section(form.NamedSection, 'main', 'tunnel-ddns', _('Switch off'));
		o = s.option(form.Button, '_revert', _('Switch everything off'),
			_('Stops dynamic DNS updates, closes the HTTPS port, returns the router\'s web server to its administration pages with the standard login and removes the certificate renewal and content-rebuild jobs. Certificates, sites and settings are kept.'));
		o.inputtitle = _('Switch off');
		o.inputstyle = 'remove';
		o.onclick = L.bind(this.handleRevert, this);

		return m.render().then(L.bind(function(nodes) {
			poll.add(L.bind(this.refresh, this), 5);
			return nodes;
		}, this));
	}
});
