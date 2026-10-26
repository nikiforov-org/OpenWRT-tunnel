'use strict';
'require view';
'require ui';
'require fs';
'require uci';
'require poll';
'require dom';

/*
 * Modem → SMS — a mail-client layout: folder list on the left, message list on
 * the right, and clicking a message opens it in place.
 *
 * Mailbox for the cellular modem: folders, an on-device archive that outlives
 * the SIM's 30 message slots, conversations, USSD, and forwarding of incoming
 * messages. Design and hardware constraints: SMS-ROADMAP.md.
 *
 * All work is done by /usr/bin/smsctl (JSON in, JSON out); this view renders it.
 */

var CTL = '/usr/bin/smsctl';

var FOLDERS = [
	{ id: 'inbox',  title: _('Inbox')  },
	{ id: 'sent',   title: _('Sent')   },
	{ id: 'outbox', title: _('Outbox') },
	{ id: 'drafts', title: _('Drafts') }
];

/* Every message table shows these same four fields — folders, search results
   and conversations alike. Defined once so they cannot diverge. */
var MSG_COLS = [
	{ cls: 'sms-col-time', title: _('Time') },
	{ cls: 'sms-col-peer', title: _('To') },
	{ cls: 'sms-col-peer', title: _('From') },
	{                      title: _('Preview') }
];

/* The mailbox views, offered as one dropdown rather than five separate links.
   The first entry is what the page opens on. */
var MAILBOX = [
	{ id: 'threads', title: _('Conversations') },
	{ id: 'inbox',   title: _('Inbox')  },
	{ id: 'sent',    title: _('Sent')   },
	{ id: 'outbox',  title: _('Outbox') },
	{ id: 'drafts',  title: _('Drafts') }
];

/* Everything that is not a mailbox gets a button of its own. */
var LINKS = [
	{ id: 'ussd',     title: _('USSD') },
	{ id: 'settings', title: _('Settings') }
];

function isMailbox(id) {
	return MAILBOX.some(function(m) { return m.id == id; });
}

var CSS = '' +
'.sms-bar{display:flex;gap:1em;align-items:center;margin:.6em 0 .9em}' +
'.sms-bar .sms-new{flex:0 0 13em}' +
'.sms-bar .sms-new button{width:100%}' +
'.sms-bar .sms-find{flex:1 1 auto;display:flex;gap:.4em;min-width:0}' +
'.sms-bar .sms-find input{flex:1 1 auto;min-width:0}' +
'@media (max-width:700px){.sms-bar{flex-direction:column;align-items:stretch}' +
  '.sms-bar .sms-new{flex:1 1 auto}}' +
'.sms-wrap{display:flex;gap:1em;align-items:flex-start}' +
/* The menu is a column of buttons, the same width as the New message button
   above it, so the whole left edge reads as one stack of controls. */
'.sms-nav{flex:0 0 13em;display:flex;flex-direction:column;gap:.4em}' +
'.sms-nav > button,.sms-nav .cbi-dropdown{width:100%}' +
'.sms-nav .cbi-dropdown{display:flex;justify-content:center}' +
'.sms-body{flex:1 1 auto;min-width:0}' +
'.sms-row{cursor:pointer}' +

/* Message lists. Truncation needs all three of these together: a fixed table
   layout (so a column keeps its width instead of growing to fit the text),
   overflow clipping on the cell, and the ellipsis on a block wrapper *inside*
   the cell — text-overflow on a display:table-cell box is not reliable. */
'.sms-table{table-layout:fixed;width:100%;max-width:100%}' +
'.sms-table .th,.sms-table .td{overflow:hidden}' +
'.sms-table .sms-clip{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
/* A column may opt out of truncation when its content is the point of the row
   (a USSD reply is several lines and there is nowhere to drill into). */
'.sms-table .sms-flow{white-space:pre-wrap;word-break:break-word}' +
/* Column widths live on <col>, so they are declared once per table instead of
   being repeated on every cell. */
'.sms-col-time{width:11em}.sms-col-peer{width:14em}' +
'.sms-col-folder{width:7em}.sms-col-label{width:14em}' +
'@media (max-width:900px){.sms-col-time{width:8.5em}.sms-col-peer{width:9em}}' +

/* A conversation reads like a messenger: oldest at the top, newest at the
   bottom, each side on its own edge. */
'.sms-chat{display:flex;flex-direction:column;max-height:34em;overflow:auto;padding:.3em}' +
'.sms-bubble{margin:.35em 0;padding:.5em .7em;border-radius:8px;max-width:80%}' +
'.sms-bubble.sms-in{align-self:flex-start;background:var(--background-color-low,#f3f3f3)}' +
'.sms-bubble.sms-out{align-self:flex-end;background:#4da1c0;color:#000}' +
'.sms-bubble.sms-out .sms-head{opacity:.85}' +
/* The delivery state sits apart from the sender and the time. */
'.sms-bubble .sms-state{margin-left:.8em;font-style:italic}' +
'.sms-bubble .sms-head{display:flex;flex-wrap:wrap;gap:.4em;align-items:center;' +
  'font-size:.85em;opacity:.75;margin-bottom:.25em}' +
'.sms-bubble .sms-head button{padding:0 .5em;font-size:.9em;line-height:1.7}' +
'.sms-bubble .sms-text{white-space:pre-wrap;word-break:break-word}' +
'.sms-full{white-space:pre-wrap;word-break:break-word;padding:.7em .9em;' +
  'border:1px solid var(--border-color-medium,#ccc);border-radius:4px}' +
'@media (max-width:700px){.sms-wrap{flex-direction:column}.sms-nav{flex:1 1 auto;width:100%}}';

function ctl(/* ...args */) {
	var args = Array.prototype.slice.call(arguments).map(String);
	return fs.exec(CTL, args).then(function(res) {
		var out;
		try { out = JSON.parse(res.stdout || '{}'); }
		catch (e) { throw new Error(_('Unexpected reply: %s').format((res.stdout || res.stderr || '').substr(0, 200))); }
		if (!out.ok) throw new Error(out.error || _('command failed'));
		return out;
	});
}

function fmtTime(ts) {
	var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ts || '');
	return m ? '%s.%s.%s %s:%s'.format(m[3], m[2], m[1], m[4], m[5]) : (ts || '');
}

/* Names read from the SIM phonebook, keyed by number. */
var CONTACTS = {};

/* Every card the dongle has messages for, keyed by ICCID. Listings span all of
   them, so a message must be shown with the identity of the card it arrived on
   — which is not necessarily the card inserted right now. */
var SIMS = {};

/* The correspondent: phonebook name if known, else the number, else the
   operator (service messages arrive from an alphanumeric sender). */
function peerOf(m) {
	var p = (m && m.peer) || '';
	if (p && CONTACTS[p]) return CONTACTS[p] + ' (' + p + ')';
	return p || (m && m.operator) || '—';
}

function err(e) { ui.addNotification(null, E('p', e.message || String(e)), 'danger'); }

return view.extend({
	current: 'threads',   /* the view on screen */
	mailbox: 'threads',   /* which mailbox the dropdown shows */
	query: '',

	load: function() {
		return Promise.all([
			ctl('status').catch(function(e) { return { error: e.message }; }),
			ctl('counts').catch(function() { return {}; }),
			ctl('contacts').catch(function() { return { contacts: [] }; }),
			ctl('sims').catch(function() { return { mailboxes: [] }; }),
			uci.load('sms')
		]);
	},

	/* ------------------------------------------------------------ navigation */

	go: function(id, arg) {
		this.current = id;

		/* Opening a message or composing one does not leave the mailbox, so the
		   dropdown keeps showing where the user came from. */
		if (isMailbox(id)) {
			this.mailbox = id;
			/* Navigation can also come from a button ("Reply" lands in Sent),
			   so the widget is told to follow. */
			if (this.mailboxWidget && this.mailboxWidget.getValue() != id)
				this.mailboxWidget.setValue(id);
		}

		var buttons = document.querySelectorAll('.sms-nav button[data-view]');
		if (buttons) buttons.forEach(function(b) {
			b.classList.toggle('cbi-button-action', b.getAttribute('data-view') == id);
		});

		return this.renderBody(id, arg);
	},

	/* The mailbox button: a ui.ComboButton, the same widget LuCI uses for
	   "Save & Apply" — a real button whose caret opens the list of the other
	   mailboxes. Clicking the body of the button opens whatever it currently
	   shows; picking an entry from the list goes straight there.

	   Rebuilt whenever the counts change, so the numbers in the labels stay
	   current. */
	renderMailbox: function(counts) {
		var self = this, choices = {}, order = [], classes = {};

		MAILBOX.forEach(function(m) {
			var n = counts ? counts[m.id] : null;
			order.push(m.id);
			choices[m.id] = (n != null) ? '%s (%d)'.format(m.title, n) : m.title;
			classes[m.id] = 'btn cbi-button cbi-button-action important';
		});

		this.mailboxWidget = new ui.ComboButton(this.mailbox, choices, {
			sort: order,
			classes: classes,
			click: function(ev, value) { self.go(value); }
		});

		var node = this.mailboxWidget.render();
		node.addEventListener('cbi-dropdown-change', function() {
			var v = self.mailboxWidget.getValue();
			if (v && v != self.current) self.go(v);
		});
		return node;
	},

	renderBody: function(id, arg) {
		var self = this,
		    body = document.getElementById('sms-body');
		if (!body) return Promise.resolve();

		var busy = function() { dom.content(body, E('p', { 'class': 'spinning' }, _('Loading…'))); },
		    fail = function(e) { dom.content(body, E('div', { 'class': 'alert-message warning' }, e.message)); };

		if (FOLDERS.some(function(f) { return f.id == id; })) {
			busy();
			return ctl('archive', id, 200, '').then(function(res) {
				dom.content(body, self.viewFolder(id, res.messages, res.error));
			}).catch(fail);
		}

		switch (id) {
		case 'threads':
			busy();
			return ctl('threads').then(function(res) {
				dom.content(body, self.viewThreads(res.threads));
			}).catch(fail);

		case 'thread':
			busy();
			return ctl('thread', arg).then(function(res) {
				dom.content(body, self.viewThread(arg, res.messages));
			}).catch(fail);

		case 'search':
			busy();
			return ctl('archive', 'all', 500, arg || '').then(function(res) {
				dom.content(body, self.viewSearch(arg, res.messages));
			}).catch(fail);

		case 'message':
			dom.content(body, this.viewMessage(arg));
			return Promise.resolve();

		case 'compose':
			dom.content(body, this.viewCompose(arg));
			return Promise.resolve();

		case 'ussd':
			busy();
			return ctl('ussd-log', 20).catch(function() { return { entries: [] }; }).then(function(res) {
				dom.content(body, self.viewUssd(res.entries));
			});

		case 'settings':
			dom.content(body, this.viewSettings());
			return Promise.resolve();
		}
		return Promise.resolve();
	},

	refreshCounts: function() {
		var self = this;
		return ctl('counts').then(function(c) {
			var host = document.getElementById('sms-mailbox');
			/* Never rebuild the list while it is open under the user's cursor. */
			if (host && !host.querySelector('.cbi-dropdown[open]'))
				dom.content(host, self.renderMailbox(c));
		}).catch(function() {});
	},

	/* Our own side of a conversation, resolved for the card the message belongs
	   to: its number — read from the card when it carries one, otherwise the one
	   entered in its settings — and the operator's name when there is no number.
	   Messages from a card that is no longer inserted keep their own identity. */
	selfName: function(m) {
		var icc = m && m.iccid,
		    sim = (icc && SIMS[icc]) || {},
		    st  = this.status || {};

		if (icc && icc != st.iccid)
			return sim.number || sim.operator || sim.label || (m && m.operator) || icc;

		return st.number || st.operator || sim.number || _('this SIM');
	},

	/* The cells of one message, in MSG_COLS order. `badge` is an optional node
	   appended to whichever of To/From holds the correspondent — Conversations
	   uses it for the message count. */
	messageCells: function(m, badge) {
		var peer = peerOf(m),
		    out  = (m.dir == 'out'),
		    me   = this.selfName(m),
		    to   = out ? peer : me,
		    from = out ? me   : peer;

		var cell = function(text, isPeer) {
			return (isPeer && badge)
				? { title: text, content: [ text, ' ', badge ] }
				: { title: text, content: text };
		};

		return [
			{ content: fmtTime(m.ts) },
			cell(to,   out),
			cell(from, !out),
			{ title: m.text || '', content: [
				(m.state == 'failed')    ? E('span', { 'class': 'label warning', 'style': 'margin-right:.4em' }, _('failed')) : '',
				(m.state == 'delivered') ? E('span', { 'class': 'label notice',  'style': 'margin-right:.4em' }, _('delivered')) : '',
				(m.text || '').replace(/\s+/g, ' ')
			] }
		];
	},

	/* ------------------------------------------------------------- the table */

	/* Every table on this page is built here — the four folders, search results,
	   Conversations, the USSD log and the message card. There is deliberately no
	   second table builder: hand-copied variants of this markup had already
	   drifted apart once, and a page-wide look is exactly what a mail client
	   needs.

	   `cols`  — [{ title, cls, flow }]
	             title — column heading; omit on every column for a headless table
	             cls   — column-width class (declared once in the CSS above)
	             flow  — let this column wrap instead of truncating it
	   `items` — [{ click, cells: [{ content, title }] }], click makes the row
	             clickable, cell.title is the tooltip carrying the untruncated text
	   `empty` — placeholder shown when there is nothing to list

	   Cell content always goes into a wrapper element: .sms-clip is what actually
	   produces the ellipsis, .sms-flow opts a column out of truncation. */
	renderTable: function(cols, items, empty) {
		var parts = [ E('colgroup', {}, cols.map(function(c) {
			return E('col', c.cls ? { 'class': c.cls } : {});
		})) ];

		if (cols.some(function(c) { return c.title != null; }))
			parts.push(E('tr', { 'class': 'tr table-titles' }, cols.map(function(c) {
				return E('th', { 'class': 'th' }, E('div', { 'class': 'sms-clip' }, c.title || ''));
			})));

		var rows = items.map(function(it, i) {
			return E('tr', {
				'class': 'tr cbi-rowstyle-' + ((i % 2) ? 2 : 1) + (it.click ? ' sms-row' : ''),
				'click': it.click
			}, it.cells.map(function(cell, n) {
				var flow = (cols[n] || {}).flow;
				return E('td', { 'class': 'td' }, E('div', {
					'class': flow ? 'sms-flow' : 'sms-clip',
					'title': flow ? null : (cell.title || '')
				}, cell.content));
			}));
		});

		if (!rows.length)
			rows = [ E('tr', { 'class': 'tr placeholder' },
				E('td', { 'class': 'td', 'colspan': String(cols.length) }, E('em', {}, empty || ''))) ];

		return E('table', { 'class': 'table sms-table' }, parts.concat(rows));
	},

	viewFolder: function(folder, messages, error) {
		var self = this,
		    spec = FOLDERS.filter(function(f) { return f.id == folder; })[0] || FOLDERS[0];

		var items = (messages || []).map(function(m) {
			return {
				click: ui.createHandlerFn(self, 'go', 'message', m),
				cells: self.messageCells(m)
			};
		});

		return E('div', {}, [
			E('h3', {}, spec.title),
			error ? E('div', { 'class': 'alert-message warning' }, error) : '',
			this.renderTable(MSG_COLS, items, _('No messages')),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', { 'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleSync') }, _('Fetch from SIM')), ' ',
				(folder == 'outbox') ? E('button', { 'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handleFlush') }, _('Retry now')) : '', ' ',
				E('button', { 'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleExport') }, _('Export')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-remove',
					'click': ui.createHandlerFn(this, 'handleArchiveClear', folder) }, _('Clear archive'))
			])
		]);
	},

	/* Search results across every folder — the Gmail-style global search. */
	viewSearch: function(query, messages) {
		var self = this;
		var items = (messages || []).map(function(m) {
			return {
				click: ui.createHandlerFn(self, 'go', 'message', m),
				cells: self.messageCells(m)
			};
		});

		return E('div', {}, [
			E('h3', {}, _('Search: %s').format(query)),
			E('div', { 'class': 'cbi-value-description' },
				_('%d message(s) across all folders.').format((messages || []).length)),
			this.renderTable(MSG_COLS, items, _('Nothing found'))
		]);
	},

	/* One message, opened in place — every stored field. */
	/* Every stored field of a message. Used by the message card and by the info
	   popup inside a conversation, so the two cannot show different things. */
	messageFields: function(m) {
		var rows = [
			[ _('Direction'),   m.dir == 'out' ? _('Outgoing') : _('Incoming') ],
			[ _('Folder'),      m.folder ],
			/* Both sides are always shown, the same way the message tables fill
			   their To and From columns. */
			[ _('To'),          (m.dir == 'out') ? peerOf(m) : this.selfName(m) ],
			[ _('From'),        (m.dir == 'out') ? this.selfName(m) : peerOf(m) ],
			[ _('Time'),        fmtTime(m.ts) + (m.ts ? '  (' + m.ts + ')' : '') ],
			[ _('State'),       m.state || '—' ],
			/* Kept for records imported from a device that could ask for delivery
			   reports; this modem cannot, so it is never set on new messages. */
			m.delivered ? [ _('Delivered'), m.delivered ] : null,
			[ _('Operator'),    m.operator || '—' ],
			[ _('SIM (ICCID)'), m.iccid || '—' ],
			[ _('IMSI'),        m.imsi || '—' ],
			[ _('SMS centre'),  m.smsc || '—' ],
			[ _('Identifier'),  m.id || '—' ]
		].filter(Boolean);
		if (m.error) rows.push([ _('Error'), m.error ]);
		return rows;
	},

	/* The same fields as a popup, so a message can be inspected without leaving
	   the conversation. */
	showMessageInfo: function(m) {
		ui.showModal(peerOf(m), [
			this.renderTable(
				[ { cls: 'sms-col-label' }, { flow: true } ],
				this.messageFields(m).map(function(r) {
					return { cells: [ { content: E('strong', {}, r[0]) }, { content: r[1] } ] };
				})),
			E('h4', {}, _('Text')),
			E('div', { 'class': 'sms-full' }, m.text || ''),
			E('div', { 'class': 'right' },
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Close')))
		]);
	},

	viewMessage: function(m) {
		var self = this;

		return E('div', {}, [
			E('div', { 'style': 'margin-bottom:.6em' },
				E('button', { 'class': 'cbi-button',
					'click': ui.createHandlerFn(this, 'go', m.folder || 'inbox') }, '← ' + _('Back'))),
			E('h3', {}, peerOf(m)),
			this.renderTable(
				[ { cls: 'sms-col-label' }, { flow: true } ],
				this.messageFields(m).map(function(r) {
					return { cells: [ { content: E('strong', {}, r[0]) }, { content: r[1] } ] };
				})),
			E('h4', {}, _('Text')),
			E('div', { 'class': 'sms-full' }, m.text || ''),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', { 'class': 'cbi-button cbi-button-apply important',
					'click': ui.createHandlerFn(this, 'go', 'compose', { to: m.peer }) }, _('Reply')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'go', 'thread', m.peer) }, _('Whole conversation')), ' ',
				E('button', {
					'class': 'cbi-button cbi-button-remove',
					'click': ui.createHandlerFn(this, function() {
						return ctl('archive-delete', m.id).then(function() {
							self.refreshCounts();
							return self.go(m.folder || 'inbox');
						}).catch(err);
					})
				}, _('Delete'))
			])
		]);
	},

	/* --------------------------------------------------------- conversations */

	viewThreads: function(threads) {
		var self = this,
		    list = (threads || []).slice().sort(function(a, b) { return (a.ts < b.ts) ? 1 : -1; });

		var items = list.map(function(t) {
			return {
				click: ui.createHandlerFn(self, 'go', 'thread', t.peer),
				cells: self.messageCells(t, E('span', { 'class': 'label' }, String(t.count)))
			};
		});

		return E('div', {}, [
			E('h3', {}, _('Conversations')),
			this.renderTable(MSG_COLS, items, _('No conversations'))
		]);
	},

	/* One conversation, laid out like a messenger: participants in the heading,
	   oldest message at the top and the newest at the bottom, every message
	   headed by who sent it, and the reply box on this same page. */
	viewThread: function(peer, messages) {
		var self = this,
		    list = (messages || []).slice().reverse(),
		    them = peerOf({ peer: peer }),
		    me   = this.selfName(list[0] || {});

		var bubbles = list.map(function(m) {
			var out = (m.dir == 'out');
			return E('div', { 'class': 'sms-bubble ' + (out ? 'sms-out' : 'sms-in') }, [
				E('div', { 'class': 'sms-head' }, [
					E('strong', {}, out ? me : them),
					fmtTime(m.ts),
					(out && m.state) ? E('em', { 'class': 'sms-state' }, m.state) : '',
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'click': ui.createHandlerFn(self, 'showMessageInfo', m)
					}, _('info'))
				]),
				E('div', { 'class': 'sms-text' }, m.text || '')
			]);
		});

		if (!bubbles.length)
			bubbles = [ E('em', {}, _('No messages in this conversation yet.')) ];

		/* Open at the newest message, the way a chat does. */
		window.setTimeout(function() {
			var box = document.getElementById('sms-chat');
			if (box) box.scrollTop = box.scrollHeight;
		}, 0);

		return E('div', {}, [
			E('div', { 'style': 'margin-bottom:.6em' },
				E('button', { 'class': 'cbi-button',
					'click': ui.createHandlerFn(this, 'go', 'threads') }, '\u2190 ' + _('Back'))),
			E('h3', {}, '%s \u2194 %s'.format(me, them)),
			E('div', { 'class': 'sms-chat', 'id': 'sms-chat' }, bubbles),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Reply')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('textarea', { 'id': 'sms-reply', 'class': 'cbi-input-textarea',
						'rows': 3, 'style': 'width:100%;max-width:42em' }),
					E('div', { 'class': 'cbi-value-description' },
						_('Sent to %s from this conversation.').format(them))
				])
			]),
			E('div', { 'class': 'cbi-page-actions' },
				E('button', { 'class': 'cbi-button cbi-button-apply important',
					'click': ui.createHandlerFn(this, 'handleReply', peer) }, _('Send')))
		]);
	},

	/* Reply without leaving the conversation; the thread reloads with the new
	   message at the bottom. */
	handleReply: function(peer) {
		var self = this,
		    box  = document.getElementById('sms-reply'),
		    text = box ? box.value : '';

		if (!text.trim()) {
			ui.addNotification(null, E('p', _('The message is empty.')), 'warning');
			return Promise.resolve();
		}

		return ctl('send', peer, text).then(function() {
			self.refreshCounts();
			return self.go('thread', peer);
		}).catch(function(e) {
			ui.addNotification(null, E('p', [
				E('strong', {}, _('Could not send — kept in the outbox for a retry.')),
				E('br'), e.message
			]), 'danger');
			self.refreshCounts();
			return self.go('outbox');
		});
	},

	/* --------------------------------------------------------------- compose */

	viewCompose: function(arg) {
		return E('div', {}, [
			E('h3', {}, _('New message')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('To')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', {
						'type': 'text', 'id': 'sms-to', 'class': 'cbi-input-text',
						'placeholder': '+…', 'value': (arg && arg.to) || '', 'style': 'width:16em'
					}),
					E('div', { 'class': 'cbi-value-description' },
						_('International format, including the country code.'))
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Message')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('textarea', { 'id': 'sms-text', 'class': 'cbi-input-textarea',
						'rows': 6, 'style': 'width:100%;max-width:42em' }),
					E('div', { 'class': 'cbi-value-description' },
						_('Longer texts are split into several messages by the network.'))
				])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', { 'class': 'cbi-button cbi-button-apply important',
					'click': ui.createHandlerFn(this, 'handleSend', false) }, _('Send')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleSend', true) }, _('Save as draft'))
			])
		]);
	},

	/* ------------------------------------------------------------------ USSD */

	viewUssd: function(entries) {
		/* A menu session survives a page reload — reflect it so the answer field
		   is available instead of silently failing on the next query. */
		var pending = (this.status || {}).ussd == 'user-response';

		return E('div', {}, [
			E('h3', {}, _('USSD')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Code')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'type': 'text', 'id': 'ussd-code', 'class': 'cbi-input-text',
						'placeholder': '*100#', 'style': 'width:12em' }), ' ',
					E('button', { 'class': 'cbi-button cbi-button-action',
						'click': ui.createHandlerFn(this, 'handleUssd', false) }, _('Send')), ' ',
					E('button', { 'class': 'cbi-button cbi-button-reset',
						'click': ui.createHandlerFn(this, 'handleUssdCancel') }, _('Close session')),
					E('div', { 'class': 'cbi-value-description' },
						_('Operator service codes, e.g. balance or package queries.'))
				])
			]),
			E('div', { 'class': 'cbi-value', 'id': 'ussd-answer-row',
				'style': pending ? '' : 'display:none' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Your choice')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'type': 'text', 'id': 'ussd-answer', 'class': 'cbi-input-text',
						'placeholder': '1', 'style': 'width:12em' }), ' ',
					E('button', { 'class': 'cbi-button cbi-button-action',
						'click': ui.createHandlerFn(this, 'handleUssd', true) }, _('Reply')),
					E('div', { 'class': 'cbi-value-description' }, _('The session is waiting for a menu selection.'))
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Reply')),
				E('div', { 'class': 'cbi-value-field' },
					E('div', { 'id': 'ussd-reply',
						'style': 'padding:.5em .75em;border:1px solid var(--border-color-medium,#ccc);' +
						         'border-radius:3px;min-height:2.5em;white-space:pre-wrap'
					}, E('em', {}, pending
						? _('A session is open and waiting for your choice.')
						: _('No session.'))))
			]),
			E('h4', {}, _('Scheduled results')),
			this.renderTable([
				{ cls: 'sms-col-time',   title: _('Time') },
				{ cls: 'sms-col-folder', title: _('Code') },
				{ flow: true,            title: _('Reply') }
			], (entries || []).map(function(e) {
				return { cells: [
					{ content: fmtTime(e.ts) },
					{ content: e.code || '' },
					{ content: e.reply || '' }
				] };
			}), _('The scheduled query has not run yet.'))
		]);
	},

	/* -------------------------------------------------------------- settings */

	viewSettings: function() {
		var st  = this.status || {},
		    s   = function(k, d) { return uci.get('sms', 'settings', k) || d || ''; },
		    chk = function(id, on) { return E('input', { 'type': 'checkbox', 'id': id, 'checked': on ? '' : null }); };

		return E('div', {}, [
			E('h3', {}, _('Settings')),

			E('h4', {}, _('This SIM card')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Label')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'type': 'text', 'id': 'set-label', 'class': 'cbi-input-text',
						'value': st.label || '', 'style': 'width:16em' }),
					E('div', { 'class': 'cbi-value-description' },
						_('Prefilled with the operator name. The card is recognised by its ICCID (%s), so its settings follow it between devices.')
							.format(st.iccid || '—'))
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Own number')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'type': 'text', 'id': 'set-number', 'class': 'cbi-input-text',
						'value': st.number || '', 'style': 'width:16em' }),
					E('div', { 'class': 'cbi-value-description' },
						_('Read from the card when it carries one; most operators leave it empty, and then it is worth entering here — it is shown as your side in To and From.'))
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('APN')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'type': 'text', 'id': 'set-apn', 'class': 'cbi-input-text',
						'value': st.apn || '', 'style': 'width:16em' }),
					E('div', { 'class': 'cbi-value-description' },
						_('Kept with the card and written to the data connection; it takes effect the next time the connection comes up.'))
				])
			]),

			E('h4', {}, _('Scheduled operator query')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Run a USSD code regularly')),
				E('div', { 'class': 'cbi-value-field' }, [
					chk('set-us', s('ussd_schedule') == '1'), ' ',
					E('input', { 'type': 'text', 'id': 'set-us-code', 'class': 'cbi-input-text',
						'placeholder': '*100#', 'value': s('ussd_code'), 'style': 'width:10em' }), ' ',
					E('input', { 'type': 'text', 'id': 'set-us-interval', 'class': 'cbi-input-text',
						'value': s('ussd_interval', '86400'), 'style': 'width:8em' }),
					E('div', { 'class': 'cbi-value-description' },
						_('Code and interval in seconds (86400 = once a day); results appear on the USSD page.'))
				])
			]),

			E('h4', {}, _('Forward incoming messages')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Telegram')),
				E('div', { 'class': 'cbi-value-field' }, [
					chk('set-tg', s('forward_telegram') == '1'), ' ',
					E('input', { 'type': 'text', 'id': 'set-tg-token', 'class': 'cbi-input-text',
						'placeholder': _('bot token'), 'value': s('telegram_token'), 'style': 'width:20em' }), ' ',
					E('input', { 'type': 'text', 'id': 'set-tg-chat', 'class': 'cbi-input-text',
						'placeholder': _('chat id'), 'value': s('telegram_chat'), 'style': 'width:10em' })
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Webhook')),
				E('div', { 'class': 'cbi-value-field' }, [
					chk('set-wh', s('forward_webhook') == '1'), ' ',
					E('input', { 'type': 'text', 'id': 'set-wh-url', 'class': 'cbi-input-text',
						'placeholder': 'https://…', 'value': s('webhook_url'), 'style': 'width:30em' }),
					E('div', { 'class': 'cbi-value-description' }, _('The message is POSTed as JSON.'))
				])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', { 'class': 'cbi-button cbi-button-apply important',
					'click': ui.createHandlerFn(this, 'handleSettingsSave', st.iccid) }, _('Save')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleForwardTest') }, _('Send a test'))
			])
		]);
	},

	/* -------------------------------------------------------------- handlers */

	handleSync: function() {
		var self = this;
		return ctl('sync').then(function(res) {
			ui.addNotification(null, E('p', _('Imported %d message(s) from the SIM.').format(res.imported)), 'info');
			self.refreshCounts();
			return self.go(self.current);
		}).catch(err);
	},

	handleFlush: function() {
		var self = this;
		return ctl('queue-flush').then(function(res) {
			ui.addNotification(null, E('p', _('Sent %d, still pending %d.').format(res.sent, res.pending)), 'info');
			self.refreshCounts();
			return self.go('outbox');
		}).catch(err);
	},

	handleExport: function() {
		return fs.exec(CTL, [ 'export' ]).then(function(res) {
			var blob = new Blob([ res.stdout || '' ], { type: 'application/x-ndjson' }),
			    url  = URL.createObjectURL(blob),
			    a    = E('a', { 'href': url, 'download': 'sms-archive.jsonl', 'style': 'display:none' });
			document.body.appendChild(a); a.click();
			window.setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 0);
		}).catch(err);
	},

	handleArchiveClear: function(folder) {
		if (!confirm(_('Delete the whole archive of this SIM? This cannot be undone.')))
			return Promise.resolve();
		var self = this;
		return ctl('archive-delete', 'all').then(function() {
			self.refreshCounts();
			return self.go(folder);
		}).catch(err);
	},

	handleSend: function(asDraft) {
		var self   = this,
		    number = document.getElementById('sms-to').value.trim(),
		    text   = document.getElementById('sms-text').value;

		if (!number) { ui.addNotification(null, E('p', _('Enter the recipient number.')), 'warning'); return Promise.resolve(); }
		if (!text)   { ui.addNotification(null, E('p', _('The message is empty.')), 'warning'); return Promise.resolve(); }

		if (asDraft)
			return ctl('draft', number, text).then(function() {
				ui.addNotification(null, E('p', _('Saved to drafts.')), 'info');
				self.refreshCounts();
				return self.go('drafts');
			}).catch(err);

		ui.showModal(_('Sending'), [ E('p', { 'class': 'spinning' }, _('Handing the message to the network…')) ]);
		return ctl('send', number, text).then(function() {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Message sent to %s').format(number)), 'info');
			self.refreshCounts();
			return self.go('sent');
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', [
				E('strong', {}, _('Could not send — kept in the outbox for a retry.')), E('br'), e.message
			]), 'danger');
			self.refreshCounts();
			return self.go('outbox');
		});
	},

	showUssd: function(res) {
		if (this.status) this.status.ussd = res.state;
		dom.content(document.getElementById('ussd-reply'), [
			E('div', {}, res.reply || _('(empty reply)')),
			E('div', { 'class': 'cbi-value-description' }, _('Session state: %s').format(res.state || 'unknown'))
		]);
		document.getElementById('ussd-answer-row').style.display = (res.state == 'user-response') ? '' : 'none';
	},

	handleUssd: function(respond) {
		var self = this,
		    code = document.getElementById(respond ? 'ussd-answer' : 'ussd-code').value.trim();
		if (!code) { ui.addNotification(null, E('p', _('Enter a code.')), 'warning'); return Promise.resolve(); }

		ui.showModal(_('USSD'), [ E('p', { 'class': 'spinning' }, _('Waiting for the network…')) ]);
		return ctl(respond ? 'ussd-respond' : 'ussd', code).then(function(res) {
			ui.hideModal();
			if (respond) document.getElementById('ussd-answer').value = '';
			self.showUssd(res);
		}).catch(function(e) { ui.hideModal(); err(e); });
	},

	handleUssdCancel: function() {
		return ctl('ussd-cancel').then(function() {
			document.getElementById('ussd-answer-row').style.display = 'none';
			dom.content(document.getElementById('ussd-reply'), E('em', {}, _('Session closed.')));
		}).catch(err);
	},

	handleSettingsSave: function(iccid) {
		var v = function(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; },
		    c = function(id) { var e = document.getElementById(id); return (e && e.checked) ? '1' : '0'; };

		uci.set('sms', 'settings', 'ussd_schedule',    c('set-us'));
		uci.set('sms', 'settings', 'ussd_code',        v('set-us-code'));
		uci.set('sms', 'settings', 'ussd_interval',    v('set-us-interval') || '86400');
		uci.set('sms', 'settings', 'forward_telegram', c('set-tg'));
		uci.set('sms', 'settings', 'telegram_token',   v('set-tg-token'));
		uci.set('sms', 'settings', 'telegram_chat',    v('set-tg-chat'));
		uci.set('sms', 'settings', 'forward_webhook',  c('set-wh'));
		uci.set('sms', 'settings', 'webhook_url',      v('set-wh-url'));

		var self = this, label = v('set-label'), number = v('set-number'), apn = v('set-apn');
		return uci.save()
			.then(function() { return uci.changes(); })
			.then(function(changed) {
				/* Applying with nothing staged answers "No data received": the
				   card's own fields — label, number, APN — are stored by smsctl
				   rather than in UCI, so a save that touched only those has
				   nothing for uci to apply. */
				var pending = 0;
				for (var conf in (changed || {})) pending++;
				return pending ? uci.apply() : null;
			})
			.then(function() { return iccid ? ctl('sim-set', iccid, label, number, apn) : null; })
			.then(function() {
				if (self.status) {
					self.status.label  = label;
					self.status.number = number;
					self.status.apn    = apn;
				}
				ui.addNotification(null, E('p', _('Settings saved.')), 'info');
			})
			.catch(err);
	},

	handleForwardTest: function() {
		return ctl('forward-test')
			.then(function() { ui.addNotification(null, E('p', _('Test message handed to the configured target.')), 'info'); })
			.catch(function(e) {
				ui.addNotification(null, E('p', [ _('No target accepted the message.'), E('br'), e.message ]), 'warning');
			});
	},

	/* ---------------------------------------------------------------- render */

	render: function(data) {
		var self   = this,
		    status = data[0] || {},
		    counts = data[1] || {};

		this.status = status;
		((data[2] || {}).contacts || []).forEach(function(c) {
			if (c.number) CONTACTS[c.number] = c.name;
		});
		((data[3] || {}).mailboxes || []).forEach(function(m) {
			if (m.iccid) SIMS[m.iccid] = m;
		});

		var head = status.error
			? E('div', { 'class': 'alert-message warning' }, status.error)
			: E('div', { 'class': 'cbi-value-description' }, [
				E('strong', {}, status.label || status.operator || _('unknown SIM')),
				status.number ? ' · ' + status.number : '',
				' · ', _('state: %s').format(status.state),
				' · ', _('SIM %s').format(status.iccid || '—')
			]);

		var nav = [ E('div', { 'id': 'sms-mailbox' }, self.renderMailbox(counts)) ];

		LINKS.forEach(function(n) {
			nav.push(E('button', {
				'data-view': n.id,
				'class': 'cbi-button' + ((n.id == self.current) ? ' cbi-button-action' : ''),
				'click': ui.createHandlerFn(self, function() { return this.go(n.id); })
			}, n.title));
		});

		var doSearch = ui.createHandlerFn(self, function() {
			var q = document.getElementById('sms-search').value.trim();
			if (!q) return self.go(self.mailbox);
			self.query = q;
			return self.go('search', q);
		});

		var toolbar = E('div', { 'class': 'sms-bar' }, [
			E('div', { 'class': 'sms-new' },
				E('button', {
					'class': 'cbi-button cbi-button-apply important',
					'click': ui.createHandlerFn(self, 'go', 'compose', null)
				}, _('New message'))),
			E('div', { 'class': 'sms-find' }, [
				E('input', {
					'type': 'text', 'id': 'sms-search', 'class': 'cbi-input-text',
					'placeholder': _('Search all messages…'),
					'keydown': function(ev) { if (ev.keyCode == 13) doSearch(ev); }
				}),
				E('button', { 'class': 'cbi-button cbi-button-action', 'click': doSearch }, _('Search'))
			])
		]);

		var page = E('div', {}, [
			E('style', { 'type': 'text/css' }, CSS),
			E('h2', {}, _('SMS')),
			head,
			toolbar,
			E('div', { 'class': 'sms-wrap' }, [
				E('div', { 'class': 'sms-nav' }, nav),
				E('div', { 'class': 'sms-body', 'id': 'sms-body' },
					E('p', { 'class': 'spinning' }, _('Loading…')))
			])
		]);

		/* fill the initial folder once the node is in the document */
		window.setTimeout(function() { self.go(self.current); }, 0);
		poll.add(function() { return self.refreshCounts(); }, 30);

		return page;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
