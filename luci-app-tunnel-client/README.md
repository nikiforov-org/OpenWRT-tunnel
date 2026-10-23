# luci-app-tunnel-client

The LuCI page **Tunnel → Client**: the devices connected to this router (by cable or Wi-Fi)
reach the Internet through tunnel clients. A profile holds the links of one server, up to
three, one per transport, as the [Server page](../luci-app-tunnel-server/README.md) of
another router shows them:

| Transport | Link |
|---|---|
| TCP + XTLS-Vision | `vless://` with `type=tcp` and `flow=xtls-rprx-vision` |
| XHTTP | `vless://` with `type=xhttp` |
| Hysteria2 | `hysteria2://` or `hy2://` |

Links of the same kinds from any other Xray or Hysteria2 server (a VPS, another router) work
too. Every link is a client; one of them is active, chosen by hand or automatically by the
measured speed. The traffic of the LAN is split by a list of domains and subnets, and nothing
of it bypasses the clients (kill switch). All clients run in one xray process, the same one as
the server of `luci-app-tunnel-server` when that package is installed.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing.

## What it does

- **The page** lists every link of the profiles with its state, the last measured speed and
  latency, and the active one. Profiles are added at the bottom of the page.
- **Interception.** While the client is on, every TCP and UDP connection of the LAN devices to
  a non-local address is handed to xray in the kernel (TPROXY: nftables rule in fw4, fwmark
  routing in netifd); xray sends it to the active link or directly, by the list. The lan → wan
  forwarding of the firewall is switched off: if xray stops, the LAN has no way to the
  Internet (kill switch), and protocols other than TCP and UDP (ping) do not leave the LAN.
  The router's own traffic (updates, dynamic DNS, the server) is not intercepted and goes
  directly. IPv6 is switched off for the LAN meanwhile, so nothing leaves next to the tunnel:
  the router advertisements stay on with a router lifetime of 0 and without a prefix, so the
  LAN devices drop their IPv6 default route at once. Private destinations (the networks behind
  the router, ZeroTier, Tailscale) are reached directly.
- **Split tunnelling** (on by default): **only what is in the list** goes through the client,
  or **everything except the list**, or everything with the splitting off. The list holds your
  entries (domains with their subdomains, subnets) and sources fetched once a day: text lists
  (one domain or IPv4 subnet per line; the v2fly domain-list-community format with `include:`,
  `full:`, `keyword:`, `regexp:` is understood) or v2fly `.dat` files (with the kind and the
  name of the list inside). Shipped: the IPv4 networks of Russia (ipverse, aggregated from the
  RIR data) and the main Russian services (v2fly `category-ru`), plus the entries `ru`, `su`,
  `xn--p1ai`; remove or replace them as you like. List downloads go through the active link
  when one works. The listed subnets are an nftables set in the kernel: connections of the LAN
  to them reach xray on an inbound of their own, which is routed as a whole (measured on the
  router with the 8 664 subnets of the shipped source: xray 13.3 MB instead of 15.4 MB, the set
  about 1 MB of kernel memory, the configuration test 0.17 s instead of 1.7 s); the domains are
  matched by xray (TLS server name, HTTP host, QUIC).
- **DNS.** dnsmasq asks xray only. xray resolves the names that go through the tunnel at the
  resolver set on the page (1.1.1.1 by default) through the active link, and the other names
  at the provider's resolvers; a listed name never falls back to the provider when the tunnel
  is down. The names of the servers themselves are always resolved at the provider. When an
  interface of the firewall zone `wan` comes up or goes down (a second uplink such as a USB
  modem, a cable pulled), the client applies its settings again, so the provider's resolvers
  are always those of the uplinks that are up.
- **The active link.** *By hand*: strictly the chosen profile and transport, even when it
  fails. *Automatic* with two links or more: every N minutes (60 by default) the test payload
  (2 MB by default) is downloaded through every link of every profile, one link after the
  other; the fastest replaces the active one when it is faster by the threshold (20 %), or at
  once when the active one failed. Every minute the active link gets a small request (a HEAD
  request to its test URL, or one byte from the server's site, about 12 KB with the
  handshakes); when it does not answer, the other links get the same request and the one that
  answers first becomes active. By hand or with a single link nothing runs on its own (**Measure
  now** still works), and the periodic measurement does not run while the router's default
  route goes through an interface of **Metered uplinks**. After every start of xray (the boot,
  the client switched on, a changed configuration of the client or of the server that shares
  the process) all links are measured and the fastest becomes active, on a metered uplink too;
  without a route to the Internet yet the minute check makes this measurement once one exists,
  and again every minute while no link answers. Switching goes through xray's API, without a
  restart. The test target is the
  server's own site through the tunnel, `https://127.0.0.1/cgi-bin/speed?bytes=N`, served by
  the site of [`luci-app-tunnel-ddns`](../luci-app-tunnel-ddns/README.md#bandwidth-test-endpoint)
  on the server (with access to local networks allowed there); a profile may name another URL
  for servers that do not have it, and its download is cut off after the test size.
- **Links that are refused:** VLESS over other transports (WebSocket, gRPC and others), TCP
  header obfuscation, an unchecked TLS certificate (`allowInsecure=1`, or `insecure=1`
  without `pinSHA256` for Hysteria2: xray has no switch for an unchecked certificate), and
  Hysteria2 port ranges. The reason is shown next to the link.

## Step by step

1. Install the package, log in to LuCI again, open **Tunnel → Client**.
2. **Profiles → Add profile…**, give it the server's name and paste its links from the
   server page (**Links** next to a profile there), **Save**. Repeat for every server.
3. Check the **Split tunnelling** section: the mode, your entries, the sources.
4. Click **Turn the client on** in the overview (it saves and applies the page like **Save &
   Apply**; **Turn the client off** switches it off the same way). The overview shows the
   service running and the links ready; **Measure now** fills the speeds and, in the
   automatic mode, picks the fastest.
5. By hand: choose **By hand**, pick the **Active link** (or **Choose** in the table) and
   apply.

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time. While the client is on:

- `/etc/tunnel-client/config.json` (mode 600): the xray configuration generated from
  `/etc/config/tunnel-client`, checked with `xray run -test` before it replaces the file in
  effect. xray runs once for this package and `luci-app-tunnel-server`:
  `/usr/libexec/tunnel-client/xray-service` (the server package ships the same script) joins
  the configuration files of the started packages into `/tmp/tunnel-xray/config.json` (checked
  with `xray run -test` too) and runs xray with it as the procd service `tunnel-xray`; xray
  restarts only when the joined file changed, and the active link is then applied again. The
  active link is a balancer target switched through xray's API on
  `127.0.0.1:61085`; the automatic choice is kept in `/etc/tunnel-client/auto.json`, the
  provider's resolvers of the last uplink in `/etc/tunnel-client/resolvers` (used at a start
  before an uplink is up). Local ports 61001 (interception), 61002 (the listed subnets), 61053
  (DNS), 61101… (one per link, for the speed test) and 61201… (one per list host) belong to it;
  direct connections from the LAN to them are refused.
- `/etc/config/firewall`: the includes `tunnel_client` (rules in
  `/etc/tunnel-client/tproxy.nft`, chain `mangle_prerouting`) and `tunnel_client_set` (the set
  `tunnel_client_listed` in `/etc/tunnel-client/listed.nft`, checked with `nft -c` before it
  replaces the one in effect), and `enabled 0` on the lan → wan forwarding.
- `/etc/config/network`: the rule `tunnel_client_rule` (fwmark 0x2222 → table 2222) and the
  route `tunnel_client_route` (local 0.0.0.0/0 in table 2222); for the LAN `ip6assign` removed
  and `wan6` disabled.
- `/etc/config/dhcp`: `dhcpv6` and `ndp` of the LAN set to `disabled`, `ra_default` removed
  (`ra relay` becomes `server`); dnsmasq `noresolv 1`
  and `server 127.0.0.1#61053` (your servers for single domains, `/domain/address`, stay), and
  `localuse 0`: the router's own lookups go to the provider's resolvers directly
  (`/tmp/resolv.conf` → `resolv.conf.auto`), so its services (dynamic DNS, updates,
  certificates) work without the active link, as its own traffic is not intercepted either.
- `/etc/crontabs/root`: in the automatic mode with two links or more the measurement and the
  check every minute, and the daily update of the sources while there are any (`#
  tunnel-client-…` lines); the file is removed when no other line is left.
- `/etc/tunnel-client/sources/`: the fetched lists and their `.meta` (the files of a removed
  source go at the next apply); `/tmp/tunnel-client/`: measurements, history, state.

The original values of everything changed are kept in `/etc/tunnel-client/backup.json` and
restored when the client is switched off.

## Removal

`apk del luci-app-tunnel-client` puts everything back: xray stops, the firewall, routing,
IPv6, dnsmasq and cron settings are restored, the generated files go, and the dependencies
installed with the package (xray-core, the nftables TPROXY and socket kernel modules, curl)
are removed unless another package needs them. `/etc/config/tunnel-client` (with the
profiles) and `/etc/tunnel-client/` (the fetched sources, the last automatic choice) stay.
