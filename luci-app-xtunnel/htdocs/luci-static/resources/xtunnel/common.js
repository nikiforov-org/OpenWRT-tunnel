'use strict';
'require baseclass';
'require ui';
'require uci';
'require form';
'require dom';

/* The helpers of the pages of luci-app-xtunnel ('require xtunnel.common as common'). */

var COLOR = { ok: '#2a9d4a', warn: '#d08a00', bad: '#d33', dim: '#888' };

function span(color, text) {
	return E('span', { 'style': color ? 'color:' + color : '' }, text);
}

/* "N seconds/minutes/hours/days ago" of an epoch time, '' without one */
function timeAgo(ts) {
	if (!ts) return '';
	var s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
	if (s < 90)       return _('%d seconds ago').format(s);
	if (s < 5400)     return _('%d minutes ago').format(Math.round(s / 60));
	if (s < 172800)   return _('%d hours ago').format(Math.round(s / 3600));
	return _('%d days ago').format(Math.round(s / 86400));
}

/* the whole days until an epoch time, null without one */
function daysLeft(expires) {
	return expires ? Math.floor((expires * 1000 - Date.now()) / 86400000) : null;
}

/* N random bytes as hexadecimal */
function randomHex(n) {
	return Array.from(crypto.getRandomValues(new Uint8Array(n)), function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
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

/* a dialog with a text (a log, a configuration file) and a header above it */
function textModal(title, text, header) {
	ui.showModal(title, [
		header || '',
		E('textarea', { 'style': 'width:100%; font-family:monospace; font-size:12px', 'rows': 24, 'readonly': 'readonly' }, text),
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close')))
	]);
}

/* the log an rpc call returns ({ log }), in a dialog */
function showLog(call, title) {
	return call().then(function(r) {
		textModal(title, (r && r.log) || _('The log is empty.'));
	});
}

/* the configuration file an rpc call returns ({ config, path }), in a dialog */
function showConfig(call, title, none) {
	return call().then(function(r) {
		textModal(title, r.config || none, E('p', { 'style': 'color:' + COLOR.dim }, r.path || ''));
	});
}

/* the result of an rpc call that restarts a service ({ ok, log } or { error }) as a notification */
function restarted(call, message) {
	return call().then(function(r) {
		if (r.error || !r.ok)
			ui.addNotification(null, E('p', r.error || r.log || _('Restart failed.')), 'error');
		else
			ui.addTimeLimitedNotification(null, E('p', message), 5000, 'info');
	});
}

/* the state of a generated configuration file: ERROR (the reason it was not applied), else written at
   TIME to PATH, else NONE (no file while it is not needed) */
function fileState(error, time, path, none) {
	if (error)
		return span(COLOR.bad, _('Not applied: %s').format(error));
	if (time)
		return span(COLOR.ok, _('Written %s to %s').format(timeAgo(time), path));
	return span(none ? COLOR.dim : COLOR.warn, none || _('Not written yet'));
}

/* the on/off button of a page: sets OPTION of the section "main" of CONFIG and saves and applies the page
   like "Save & Apply" (with the rest of its changes) */
function switchButton(view, config, option, labelOn, labelOff) {
	var on = uci.get(config, 'main', option) == '1';
	return E('button', {
		'class': 'btn cbi-button ' + (on ? 'cbi-button-negative' : 'cbi-button-positive'),
		'click': ui.createHandlerFn(view, function(ev) {
			uci.set(config, 'main', option, on ? '0' : '1');
			return view.handleSaveApply(ev, '0');
		})
	}, on ? labelOff : labelOn);
}

/* The form saved into LuCI's store: true when nothing is left unsaved, else a notification and false
   (an action of a button works with the settings applied) */
function ensureSaved(map) {
	return map.save(null, true).then(function() {
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
}

/* Saving a dialog of a table section makes LuCI re-render the whole page from its uci store, so the
   form's unsaved edits are put into the store before a dialog opens: for a new section before it is
   created (a store save renames new sections), for "Edit" right before the dialog. BEFORE_ADD: a
   promise to wait for before a new section is created. */
function saveBeforeModal(section, beforeAdd) {
	section.handleAdd = function(ev, name) {
		var args = arguments;
		return this.map.save(null, true).catch(function() {}).then(function() {
			return beforeAdd ? beforeAdd() : null;
		}).then(L.bind(function() {
			this.parentSaved = true;
			return form.GridSection.prototype.handleAdd.apply(this, args);
		}, this));
	};
	section.renderMoreOptionsModal = function(section_id, ev) {
		var args = arguments, saved = this.parentSaved;
		this.parentSaved = false;
		return (saved ? Promise.resolve() : this.map.save(null, true).catch(function() {})).then(L.bind(function() {
			return form.GridSection.prototype.renderMoreOptionsModal.apply(this, args);
		}, this));
	};
}

/* The rows of an overview: a row is filled by its CELL() and, with SHOWN(), shown only while that is true
   (a state with nothing to say is left out); updateRows() fills and shows them again after a status refresh. */
var rows = {};

function shownWhile(o, name, shown) {
	var render = o.render;
	rows[name] = rows[name] || {};
	rows[name].shown = shown;
	o.render = function() {
		return Promise.resolve(render.apply(this, arguments)).then(function(node) {
			if (node && node.style) {
				node.setAttribute('data-xt-row', name);
				node.style.display = shown() ? '' : 'none';
			}
			return node;
		});
	};
	return o;
}

function statusRow(s, name, title, cell, shown, description) {
	var o = s.option(form.DummyValue, name, title, description);
	rows[name] = { cell: cell };
	o.renderWidget = function() { return E('div', { 'data-xt-cell': name }, cell()); };
	return shown ? shownWhile(o, name, shown) : o;
}

function updateRows() {
	document.querySelectorAll('[data-xt-cell]').forEach(function(n) {
		var r = rows[n.getAttribute('data-xt-cell')];
		if (r && r.cell) dom.content(n, r.cell());
	});
	document.querySelectorAll('[data-xt-row]').forEach(function(n) {
		var r = rows[n.getAttribute('data-xt-row')];
		if (r && r.shown) n.style.display = r.shown() ? '' : 'none';
	});
}

return baseclass.extend({
	COLOR: COLOR,
	span: span,
	timeAgo: timeAgo,
	daysLeft: daysLeft,
	randomHex: randomHex,
	copyText: copyText,
	textModal: textModal,
	showLog: showLog,
	showConfig: showConfig,
	restarted: restarted,
	fileState: fileState,
	switchButton: switchButton,
	ensureSaved: ensureSaved,
	saveBeforeModal: saveBeforeModal,
	shownWhile: shownWhile,
	statusRow: statusRow,
	updateRows: updateRows
});
