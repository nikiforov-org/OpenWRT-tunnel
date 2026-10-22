# profile client: a router for client tests. The Docker network as wan, the
# LAN device a network namespace dev1 (192.168.77.10) on a routed veth: TPROXY over a Linux bridge does
# not deliver in OrbStack's kernel, on a routed veth it does. A snapshot of the state before any test
# package (config, nftables, rules, routes, packages, crontabs) is kept in /root/snap0.
"$STAGE" create "$N" wan || exit 1
"$STAGE" sh "$N" '
apk add ip-full >/dev/null 2>&1 && echo "ip-full installed"
/usr/libexec/ip-full link add veth-lan type veth peer name veth-dev1
/usr/libexec/ip-full netns add dev1
/usr/libexec/ip-full link set veth-dev1 netns dev1
/usr/libexec/ip-full netns exec dev1 sh -c "ip addr add 192.168.77.10/24 dev veth-dev1; ip link set veth-dev1 up; ip link set lo up"
mkdir -p /etc/netns/dev1; echo "nameserver 192.168.77.1" > /etc/netns/dev1/resolv.conf
ip link set veth-lan up
uci set network.lan=interface; uci set network.lan.device=veth-lan; uci set network.lan.proto=static; uci set network.lan.ipaddr=192.168.77.1/24
uci commit network
/etc/init.d/network restart; sleep 8; /etc/init.d/firewall reload >/dev/null 2>&1; /etc/init.d/dnsmasq restart; sleep 3
ip netns exec dev1 ip route replace default via 192.168.77.1
reload_config
ip netns exec dev1 wget -q -T 15 -O /dev/null https://downloads.openwrt.org/ && echo "ready: dev1 reaches the Internet through the router"
mkdir -p /root/snap0; cp -a /etc/config /root/snap0/; nft list ruleset > /root/snap0/nft.txt; ip rule > /root/snap0/iprule.txt
ip route show table all > /root/snap0/routes.txt; apk info 2>/dev/null | sort > /root/snap0/pkgs.txt; ls /etc/crontabs/ > /root/snap0/crontabs.txt' 2>&1 | grep -v udhcpc
