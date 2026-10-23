// xtunnel-ddns x509: the names and the validity of a PEM certificate, read from its DER
// encoding here (no openssl process).
//
//   import { info } from 'xtunnel.x509';
//
//   info(pem_text)   // { subject_cn, issuer_cn, issuer_o, not_before, not_after } (epoch
//                    // seconds) of the first certificate, or null if it cannot be read

'use strict';

// one DER element at position i: { tag, start (of the content), len, end }
function element(d, i) {
	if (i + 2 > length(d)) return null;
	let tag = ord(d, i), len = ord(d, i + 1), start = i + 2;
	if (len & 0x80) {
		let n = len & 0x7f;
		if (n < 1 || n > 3 || start + n > length(d)) return null;
		len = 0;
		for (let k = 0; k < n; k++) len = (len << 8) | ord(d, start + k);
		start += n;
	}
	if (start + len > length(d)) return null;
	return { tag: tag, start: start, len: len, end: start + len };
}

// the elements inside a constructed element
function children(d, e) {
	let out = [];
	for (let i = e.start; i < e.end; ) {
		let c = element(d, i);
		if (!c) return null;
		push(out, c);
		i = c.end;
	}
	return out;
}

// days since 1970-01-01 of a civil date (Howard Hinnant's algorithm)
function days(y, m, d) {
	y -= (m <= 2) ? 1 : 0;
	let era = int((y >= 0 ? y : y - 399) / 400);
	let yoe = y - era * 400;
	let doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
	let doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

// UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) → epoch seconds
function time_of(d, e) {
	let s = substr(d, e.start, e.len);
	let m = (e.tag == 0x17) ? match(s, /^([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})Z$/)
	                        : match(s, /^([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})Z$/);
	if (!m) return null;
	let y = int(m[1]);
	if (e.tag == 0x17) y += (y < 50) ? 2000 : 1900;
	return days(y, int(m[2]), int(m[3])) * 86400 + int(m[4]) * 3600 + int(m[5]) * 60 + int(m[6]);
}

// the value of an attribute (by its OID bytes) in a Name
function name_attr(d, name, oid) {
	for (let set in children(d, name) ?? [])
		for (let atv in children(d, set) ?? []) {
			let c = children(d, atv);
			if (c && length(c) == 2 && c[0].tag == 0x06 && substr(d, c[0].start, c[0].len) == oid)
				return substr(d, c[1].start, c[1].len);
		}
	return null;
}

const OID_CN = '\x55\x04\x03', OID_O = '\x55\x04\x0a';

function info(pem) {
	let m = match(pem ?? '', /-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/);
	if (!m) return null;
	let d = b64dec(replace(m[1], /[^A-Za-z0-9+\/=]/g, ''));
	if (!d) return null;
	let cert = element(d, 0);
	if (!cert || cert.tag != 0x30) return null;
	let tbs = children(d, cert)?.[0];
	if (!tbs || tbs.tag != 0x30) return null;
	let f = children(d, tbs);
	if (!f) return null;
	let i = (f[0]?.tag == 0xa0) ? 1 : 0;          // [0] version is optional
	// serialNumber, signature, issuer, validity, subject
	let issuer = f[i + 2], validity = f[i + 3], subject = f[i + 4];
	if (!issuer || !validity || !subject) return null;
	let v = children(d, validity);
	if (!v || length(v) != 2) return null;
	return {
		subject_cn: name_attr(d, subject, OID_CN),
		issuer_cn: name_attr(d, issuer, OID_CN),
		issuer_o: name_attr(d, issuer, OID_O),
		not_before: time_of(d, v[0]),
		not_after: time_of(d, v[1])
	};
}

export { info };
