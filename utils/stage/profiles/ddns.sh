# profile ddns: a router like the production one for the Dynamic DNS and web site tests through the UI
# over HTTPS by name: luci-app-tunnel-ddns and luci-app-tunnel-server (its Vision transport on 443 in
# front of the site, configured by the tests). The Docker network as lan; 443 (TCP and UDP)
# published on 127.0.0.1 of the Mac, so that a browser started with --host-resolver-rules
# "MAP <name> 127.0.0.1" (stage browser NAME) reaches it under any domain name at its real port.
# Port 443 of the Mac must be free (stop a container that publishes it, such as the lab server).
# The router's own lookups go through its dnsmasq to 1.1.1.1, as on a router: OrbStack's resolver
# (the stage default) keeps a negative answer for a new record much longer than the zone's negative TTL.
"$STAGE" create "$N" lan -p 127.0.0.1:443:443 -p 127.0.0.1:443:443/udp || exit 1
"$STAGE" sh "$N" 'uci -q delete network.lan.dns; uci add_list network.lan.dns=1.1.1.1; uci commit network
/etc/init.d/network reload >/dev/null 2>&1; sleep 4; echo "nameserver 127.0.0.1" > /etc/resolv.conf'
"$STAGE" install "$N" ddns server
