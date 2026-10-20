# luci-app-tunnel-clients

The LuCI page **Tunnel → Clients**: the devices connected to this router (by cable or Wi-Fi)
reach the Internet through tunnel clients. A client is a link to a server: the `vless://` or
`hysteria2://` link the server pages of this repository show, or a link to any other Xray or
Hysteria2 server (a VPS, another router). One client is active, chosen by hand or automatically
by the measured speed. The traffic of the LAN is split by a list of domains and subnets, and
nothing of it bypasses the clients (kill switch).

All clients run in one xray process. The client packages only turn links into xray outbounds;
install the ones you need next to this one (they depend on it):

- [`luci-app-tunnel-client-xray`](../luci-app-tunnel-client-xray/README.md): VLESS links
  (TCP + XTLS-Vision, XHTTP, WebSocket, gRPC, HTTPUpgrade; REALITY or TLS);
- [`luci-app-tunnel-client-hysteria2`](../luci-app-tunnel-client-hysteria2/README.md): Hysteria2
  links (Salamander obfuscation, certificate pinning).

Installing the packages is described in the [main README](../README.md). Log in to LuCI again
after installing.

## What it does

- **The page** lists every link of the installed client packages as a client with its state,
  the last measured speed and latency, and the active one. The links are added at the bottom of
  the same page, one section per client package.
- **Interception.** While the page is on, every TCP and UDP connection of the LAN devices to a
  non-local address is handed to xray in the kernel (TPROXY: nftables rule in fw4, fwmark
  routing in netifd); xray sends it to the active client or directly, by the list. The lan → wan
  forwarding of the firewall is switched off: if xray stops, the LAN has no way to the Internet
  (kill switch), and protocols other than TCP and UDP (ping) do not leave the LAN. The router's
  own traffic (updates, dynamic DNS, the server packages) is not intercepted and goes directly.
  IPv6 is switched off for the LAN meanwhile, so nothing leaves next to the tunnel. Private
  destinations (the networks behind the router, ZeroTier, Tailscale) are reached directly.
- **Split tunnelling** (on by default): **only what is in the list** goes through the clients,
  or **everything except the list**, or everything with the splitting off. The list holds your
  entries (domains with their subdomains, subnets) and sources fetched once a day: text lists
  (one domain or IPv4 subnet per line; the v2fly domain-list-community format with `include:`,
  `full:`, `keyword:`, `regexp:` is understood) or v2fly `.dat` files (with the kind and the
  name of the list inside). Shipped: the IPv4 networks of Russia (ipverse, aggregated from the
  RIR data) and the main Russian services (v2fly `category-ru`), plus the entries `ru`, `su`,
  `xn--p1ai`; remove or replace them as you like. List downloads go through the active client
  when one works.
- **DNS.** dnsmasq asks xray only. xray resolves the names that go through the tunnel at the
  resolver set on the page (1.1.1.1 by default) through the active client, and the other names
  at the provider's resolvers; a listed name never falls back to the provider when the tunnel is
  down. The names of the servers themselves are always resolved at the provider.
- **The active client.** *By hand*: strictly the chosen one, even when it fails. *Automatic*:
  every N minutes (10 by default) the test payload is downloaded through every client at once;
  the fastest replaces the active one when it is faster by the threshold (20 %), or at once when
  the active one failed. A health check of the active client runs every minute and starts the
  measurement when it fails. Switching goes through xray's API, without a restart. The test
  target is the server's own site through the tunnel,
  `https://127.0.0.1/cgi-bin/speed?bytes=N`, served by the site of
  [`luci-app-tunnel-ddns`](../luci-app-tunnel-ddns/README.md#bandwidth-test-endpoint) on the
  server (with access to local networks allowed there); a link may name another URL for servers
  that do not have it.

## Step by step

1. Install this package and the client packages, log in to LuCI again, open **Tunnel →
   Clients**.
2. In the section of a client package at the bottom, **Add link…**, paste the link from the
   server's **Link** dialog, **Save**. Repeat for every server and transport.
3. Check the **Split tunnelling** section: the mode, your entries, the sources.
4. Tick **Route the LAN through the clients**, click **Save & Apply**. The overview shows the
   service running and the clients ready; **Measure now** fills the speeds and, in the automatic
   mode, picks the fastest.
5. By hand: choose **By hand**, pick the **Active client** (or **Choose** in the table) and apply.

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time. While the page is on:

- `/etc/tunnel-clients/config.json` (mode 600): the xray configuration generated from
  `/etc/config/tunnel-clients` and the client packages' descriptors
  (`/tmp/tunnel-clients/<package>.json`), checked with `xray run -test` before it replaces the
  file in effect; xray runs as a procd service of this package and restarts only when the file
  changed. The active client is a balancer target switched through xray's API on
  `127.0.0.1:61085`; the automatic choice is kept in `/etc/tunnel-clients/auto.json`. Local
  ports 61001 (interception), 61053 (DNS), 61101… (one per client, for the speed test) and
  61201… (one per list host) belong to it; direct connections from the LAN to them are refused.
- `/etc/config/firewall`: the include `tunnel_clients` (rules in
  `/etc/tunnel-clients/tproxy.nft`, chain `mangle_prerouting`) and `enabled 0` on the lan → wan
  forwarding.
- `/etc/config/network`: the rule `tunnel_clients_rule` (fwmark 0x2222 → table 2222) and the
  route `tunnel_clients_route` (local 0.0.0.0/0 in table 2222); for the LAN `ip6assign` removed
  and `wan6` disabled.
- `/etc/config/dhcp`: `ra`, `dhcpv6`, `ndp` of the LAN set to `disabled`; dnsmasq `noresolv 1`
  and `server 127.0.0.1#61053` (your servers for single domains, `/domain/address`, stay).
- `/etc/crontabs/root`: the measurement, the health check every minute, the daily update of
  the sources (`# tunnel-clients-…` lines).
- `/etc/tunnel-clients/sources/`: the fetched lists and their `.meta`;
  `/tmp/tunnel-clients/`: measurements, history, state.

The original values of everything changed are kept in `/etc/tunnel-clients/backup.json` and
restored when the page is switched off.

## Removal

The client packages depend on this one, so they are removed together:

```sh
apk del luci-app-tunnel-client-xray luci-app-tunnel-client-hysteria2 luci-app-tunnel-clients
```

This puts everything back: xray stops, the firewall, routing, IPv6, dnsmasq and cron settings
are restored, the generated files go, and the dependencies installed with the packages
(xray-core, the nftables TPROXY and socket kernel modules, curl) are removed unless another
package needs them.
The uci configs (`/etc/config/tunnel-clients` and the links of the client packages) and
`/etc/tunnel-clients/` (the fetched sources, the last automatic choice) stay.
