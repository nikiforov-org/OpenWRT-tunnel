# profile server: a router as the tunnel server for client tests. The Docker network as wan,
# luci-app-tunnel-ddns serving the default site on 443,
# luci-app-tunnel-server installed (configured by the tests), a self-signed certificate for
# test.example.com in /root/hy2 for Hysteria2.
"$STAGE" create "$N" wan || exit 1
"$STAGE" install "$N" ddns server
"$STAGE" sh "$N" '
mkdir -p /root/hy2; openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=test.example.com \
	-addext subjectAltName=DNS:test.example.com -keyout /root/hy2/key.pem -out /root/hy2/cert.pem >/dev/null 2>&1 && echo "self-signed certificate for test.example.com in /root/hy2"
uci set tunnel-ddns.main.site_enabled=1; uci set tunnel-ddns.main.site=default; uci set tunnel-ddns.main.site_port=443; uci commit tunnel-ddns
/etc/init.d/tunnel-ddns reload; sleep 3
echo "site: https=[$(uci get uhttpd.main.listen_https)] speed=$(uclient-fetch -q --no-check-certificate -O - "https://127.0.0.1/cgi-bin/speed?bytes=1000" | wc -c) bytes"'
