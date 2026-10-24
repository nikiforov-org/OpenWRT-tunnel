'use strict';
// The server part's helpers, for its sync and its rpcd plugin.
//   import { certificate } from 'xtunnel-server.common';

import { access } from 'fs';

const DDNS_CERTS = '/etc/ssl/xtunnel-ddns';

// the TLS certificate of the Hysteria2 transport, from a domain of the Dynamic DNS page or from files on
// the router: { cert, key, server_name, source } or { error }
export function certificate(main, uci) {
	if ((main.cert_source ?? 'ddns') == 'files') {
		if (!main.cert_path || !main.key_path) return { error: 'the certificate and key paths are empty' };
		if (!main.cert_name) return { error: 'the TLS server name of the certificate is empty' };
		if (access(main.cert_path) != true || access(main.key_path) != true)
			return { error: `the certificate or key file is missing (${main.cert_path}, ${main.key_path})` };
		return { cert: main.cert_path, key: main.key_path, server_name: main.cert_name, source: 'files' };
	}
	if (!main.cert_domain) return { error: 'no domain is selected for the Hysteria2 certificate' };
	if (!uci.load('xtunnel-ddns')) return { error: 'the Dynamic DNS settings (/etc/config/xtunnel-ddns) are missing' };
	let host = uci.get('xtunnel-ddns', main.cert_domain, 'hostname');
	if (!host) return { error: 'the domain selected for the Hysteria2 certificate no longer exists on the Dynamic DNS page' };
	let cert = `${DDNS_CERTS}/${host}/fullchain.pem`, key = `${DDNS_CERTS}/${host}/key.pem`;
	if (access(cert) != true || access(key) != true)
		return { error: `no certificate for ${host} yet: issue it on the Dynamic DNS page` };
	return { cert: cert, key: key, server_name: host, source: 'ddns' };
};
