'use strict';
'require baseclass';
'require fs';

// Adapter that feeds the upstream ModemManager status view (view/modemmanager/
// status.js) from /usr/bin/modem-info instead of mmcli. This device has no
// ModemManager (no QMI/MBIM port), so the page is driven over AT; the returned
// objects match the exact shape the view expects, so the rendered "Cellular
// Network" page matches the one on a ModemManager device.
//
// generic.device is deliberately absent: mmcli puts the modem's sysfs path
// there and the only consumer was the view's tab title, which is gone.
return baseclass.extend({
	_info: null,

	_fetch: function () {
		return fs.exec('/usr/bin/modem-info').then(L.bind(function (res) {
			try { this._info = JSON.parse((res && res.stdout) || '{}'); }
			catch (e) { this._info = {}; }
			return this._info;
		}, this));
	},

	getModems: function () {
		return this._fetch().then(L.bind(function (info) {
			var pct = parseInt(info.signal_pct);
			if (isNaN(pct)) pct = 0;
			return [ {
				modem: {
					generic: {
						'manufacturer': info.manufacturer || null,
						'model': info.model || null,
						'revision': info.firmware || null,
						'device-identifier': null,
						'power-state': (info.manufacturer || info.model) ? 'on' : null,
						'state': info.connected ? 'connected' : (info.registration || null),
						'state-failed-reason': null,
						'own-numbers': info.msisdn ? [ info.msisdn ] : [],
						'access-technologies': info.rat ? [ info.rat ] : [],
						'signal-quality': { 'value': String(pct) },
						'sim': 'sim/0',
						'sim-slots': []
					},
					'3gpp': {
						'imei': info.imei || null,
						'operator-name': info.operator || null,
						'operator-code': info.operator_code || null,
						'registration-state': info.registration || null,
						'packet-service-state': info.connected ? 'attached' : null
					}
				}
			} ];
		}, this));
	},

	getModemSims: function () {
		var info = this._info || {};
		if (!info.iccid && !info.imsi)
			return Promise.resolve([]);
		return Promise.resolve([ {
			sim: { properties: {
				'active': 'yes',
				'operator-name': info.operator || null,
				'iccid': info.iccid || null,
				'imsi': info.imsi || null
			} }
		} ]);
	},

	getModemLocation: function () {
		var info = this._info || {};
		return Promise.resolve({
			modem: { location: { '3gpp': {
				'cid': info.cell || null,
				'lac': null,
				'mcc': info.mcc || null,
				'mnc': info.mnc || null,
				'tac': info.tac || null
			} } }
		});
	}
});
