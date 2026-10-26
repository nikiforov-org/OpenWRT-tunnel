'use strict';
'require view';
'require fs';
'require ui';
'require poll';
'require dom';

// Storage tab for the USB socket: what is plugged in, and the operations that
// stock LuCI has no page for at all — mount, unmount, and formatting a drive on
// the router itself. Everything runs through /usr/bin/usb-disk, which is the
// only thing this page is allowed to execute; the device names it accepts are
// checked there rather than here, because a web page cannot be the guard.
//
// Mount Points, the upstream page, is still one tab over: this one deliberately
// does not try to replace fstab editing.

function call(args) {
	return fs.exec('/usr/bin/usb-disk', args).then(function (res) {
		var out = (res && res.stdout) || '';
		try { return JSON.parse(out); }
		catch (e) { return { ok: false, error: out.trim() || _('no answer from the router') }; }
	});
}

function fsLabel(fs_) {
	switch (fs_) {
		case 'vfat':  return 'FAT32';
		case 'exfat': return 'exFAT';
		case 'ext4':  return 'ext4';
		case 'ext3':  return 'ext3';
		case 'ext2':  return 'ext2';
		case 'ntfs':  return 'NTFS';
		case 'hfsplus': return 'HFS+';
		case 'apfs':  return 'APFS';
		case '':
		case undefined:
		case null:    return '—';
		default:      return fs_;
	}
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function () {
		return call([ 'list' ]);
	},

	// every operation here is slow and destructive, so it runs behind a modal
	// that cannot be dismissed while it works
	run: function (args, busyText) {
		ui.showModal(_('Working'), [ E('p', { 'class': 'spinning' }, busyText) ]);
		return call(args).then(L.bind(function (res) {
			ui.hideModal();
			if (!res.ok)
				ui.addNotification(null, E('p', _('Failed: %s').format(res.error || _('unknown error'))), 'error');
			return this.refresh();
		}, this));
	},

	refresh: function () {
		return this.load().then(L.bind(function (data) {
			var node = document.getElementById('usb-storage-body');
			if (node) dom.content(node, this.renderDisks(data));
		}, this));
	},

	askFormat: function (target, isWhole, name) {
		var select = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'fat32' }, 'FAT32 — ' + _('any computer, one file up to 4 GB')),
			E('option', { 'value': 'exfat' }, 'exFAT — ' + _('any computer, no limit on the size of a file')),
			E('option', { 'value': 'ext4'  }, 'ext4 — ' + _('Linux only, keeps permissions'))
		]);
		var label = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'maxlength': 16, 'value': 'USB' });

		ui.showModal(isWhole ? _('Erase the whole drive %s').format(name)
		                     : _('Format %s').format(name), [
			E('p', { 'class': 'alert-message warning' }, isWhole
				? _('Everything on the drive is destroyed: every partition, everything stored on them, and any boot loader it carries.')
				: _('Everything on this partition is destroyed.')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Filesystem')),
				E('div', { 'class': 'cbi-value-field' }, select)
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Label')),
				E('div', { 'class': 'cbi-value-field' }, [
					label,
					E('div', { 'class': 'cbi-value-description' },
						_('FAT32 takes latin letters and digits only, up to 11 of them. exFAT and ext4 take any alphabet.'))
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-negative',
					'click': L.bind(function () {
						var fsv = select.value, lbl = (label.value || '').trim();
						ui.hideModal();
						return this.run([ isWhole ? 'wipe' : 'format', target, fsv, lbl ],
							_('Formatting %s. Do not unplug the drive.').format(name));
					}, this)
				}, isWhole ? _('Erase and format') : _('Format'))
			])
		]);
	},

	renderDisks: function (data) {
		// A failing helper must not be reported as an empty socket: "nothing is
		// plugged in" is exactly the wrong thing to tell someone whose drive is
		// plugged in and whose helper is broken or missing.
		if (!data || data.ok !== true)
			return E('div', { 'class': 'cbi-section' }, [
				E('p', { 'class': 'alert-message warning' },
					_('Cannot read the drives: %s').format((data && data.error) || _('no answer from the router')))
			]);

		var disks = data.disks || [];
		if (!disks.length)
			return E('div', { 'class': 'cbi-section' }, [
				E('p', {}, _('Nothing is plugged into the USB socket.'))
			]);

		return E([], disks.map(L.bind(function (disk) {
			var rows = (disk.parts || []).map(L.bind(function (p) {
				var mounted = !!p.mount;
				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, '/dev/' + p.name),
					E('td', { 'class': 'td' }, p.size || '—'),
					E('td', { 'class': 'td' }, fsLabel(p.fs)),
					E('td', { 'class': 'td' }, p.label || '—'),
					E('td', { 'class': 'td' }, mounted ? p.mount : _('not mounted')),
					E('td', { 'class': 'td cbi-value-field' }, [
						E('button', {
							'class': 'btn cbi-button-neutral',
							'click': L.bind(function () {
								return this.run([ mounted ? 'umount' : 'mount', p.name ],
									mounted ? _('Unmounting…') : _('Mounting…'));
							}, this)
						}, mounted ? _('Unmount') : _('Mount')),
						' ',
						E('button', {
							'class': 'btn cbi-button-negative',
							'click': L.bind(function () {
								this.askFormat(p.name, false, '/dev/' + p.name);
							}, this)
						}, _('Format'))
					])
				]);
			}, this));

			if (!rows.length)
				rows = [ E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '6' },
						_('The drive has no partitions the router can read. Use "Erase the whole drive".'))
				]) ];

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, '%s — %s%s'.format('/dev/' + disk.name, disk.size,
					disk.model ? ' (' + disk.model + ')' : '')),
				E('table', { 'class': 'table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Partition')),
						E('th', { 'class': 'th' }, _('Size')),
						E('th', { 'class': 'th' }, _('Filesystem')),
						E('th', { 'class': 'th' }, _('Label')),
						E('th', { 'class': 'th' }, _('Mounted at')),
						E('th', { 'class': 'th' }, _('Actions'))
					])
				].concat(rows)),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button-negative',
						'click': L.bind(function () {
							this.askFormat(disk.name, true, '/dev/' + disk.name);
						}, this)
					}, _('Erase the whole drive'))
				])
			]);
		}, this)));
	},

	render: function (data) {
		var body = E('div', { 'id': 'usb-storage-body' }, this.renderDisks(data));

		poll.add(L.bind(this.refresh, this), 10);

		return E([], [
			E('h2', {}, _('USB Storage')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Drives plugged into the socket on the case. Formatting happens on the router — the drive does not have to be taken to a computer. Sharing a drive over the network is on the Shares tab.')),
			body
		]);
	}
});
