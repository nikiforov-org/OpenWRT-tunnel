# profile server: a router as the tunnel server for client tests. The Docker network as wan,
# luci-app-xtunnel with its Dynamic DNS part serving the default site on
# 443, the server configured by the tests, a self-signed certificate for
# test.example.com in /root/hy2 for Hysteria2 (made with px5g of the image).
"$STAGE" create "$N" wan || exit 1
"$STAGE" install "$N" xtunnel
"$STAGE" sh "$N" '
mkdir -p /root/hy2; px5g selfsigned -days 30 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout /root/hy2/key.pem -out /root/hy2/cert.pem \
	-subj /CN=test.example.com -addext extendedKeyUsage=serverAuth -addext subjectAltName=DNS:test.example.com >/dev/null 2>&1 &&
	echo "self-signed certificate for test.example.com in /root/hy2 (px5g of the image: openssl is no dependency)" || echo "no certificate in /root/hy2: px5g failed"
uci set xtunnel-ddns.main.site_enabled=1; uci set xtunnel-ddns.main.site=default; uci set xtunnel-ddns.main.site_port=443; uci commit xtunnel-ddns
/etc/init.d/xtunnel-ddns reload; sleep 3
echo "site: https=[$(uci get uhttpd.main.listen_https)] speed=$(uclient-fetch -q --no-check-certificate -O - "https://127.0.0.1/cgi-bin/speed?bytes=1000" | wc -c) bytes"'
