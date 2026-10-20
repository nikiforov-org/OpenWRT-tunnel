# luci-app-tunnel-server-hysteria2

The LuCI page **Tunnel → Server → Hysteria2**: a Hysteria2 server (QUIC over UDP, run by
sing-box) on the router with a real TLS certificate. Devices with a client link connect to it
over the Internet and use the router's connection. It is a second way in next to the Xray
server: a different protocol on UDP, for networks where TCP is throttled.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the page is a tab of **Tunnel → Server**.

## What it does

- **Hysteria2 over QUIC** with ordinary TLS 1.3, so the server needs a real certificate for
  the name clients connect to. The easiest source is a domain from
  [`luci-app-tunnel-ddns`](../luci-app-tunnel-ddns/README.md): pick it in the **Certificate**
  field and the server uses that domain's Let's Encrypt certificate and name. Certificate
  files on the router (PEM paths and the TLS server name) work as well. sing-box reloads the
  files by itself when they change, so renewals need nothing.
- **Profiles.** Any number of profiles, one password each, switchable on and off. The
  **Link** button shows the `hysteria2://` link and a QR code, ready for Hiddify, NekoBox,
  sing-box and the Hysteria2 apps.
- **Obfuscation** (Salamander) with one shared password, optional; **masquerade**: what a
  plain HTTP/3 visitor without a profile password gets (a URL to proxy, a file path, or a
  sing-box masquerade object), by default a 404 answer.
- **Firewall.** While the server runs, its UDP port is open from WAN (one rule). Switching
  the server off closes it.
- **Access to local networks.** A box that decides whether clients may reach the router
  itself and the networks behind it through the server, or the Internet only. BitTorrent
  traffic is always dropped.

## Step by step

1. **Server.** Leave the **UDP port** at 443 (free: the site uses TCP) or pick another one. Choose the
   **Certificate**: a domain from the Dynamic DNS page (it must have a certificate already)
   or files on the router with the TLS server name.
2. Optionally set an **Obfuscation password** (Random password) and a **Masquerade**.
3. **Client links → Address**: the public name or IP address of the router. Empty means the
   TLS server name, which is right when that name points at the router. If a router in front
   forwards a different public UDP port, enter it under **Port in client links**.
4. **Profiles → Add profile…**, give it a name (a password is filled in), **Save** in the
   dialog.
5. Tick **Run the server** and click **Save & Apply**. The overview shows "Running" and the
   open port a few seconds later.
6. **Link** next to a profile: copy the link or scan the QR code in the client app.

If the router sits behind another router or behind the provider's NAT, the UDP port must be
forwarded to it (or opened through UPnP) before clients from the Internet can connect.

Changing the password, the port, the obfuscation password or the address breaks the existing
links: export them again.

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time with the default configuration.
On a reinstall or upgrade the package's init script is started by apk, so an existing
configuration is applied again right away.

- `/etc/tunnel-server-hysteria2/config.json` (mode 600): the sing-box configuration generated
  from `/etc/config/tunnel-server-hysteria2`, which gets mode 600 as well (it holds the
  passwords). The file is replaced only after `sing-box check` accepts it; any error, from a
  missing certificate to a configuration rejected by sing-box, leaves the configuration in
  effect running and shows the reason in the overview. Only switching the server off stops it.
- sing-box runs as a procd service of this package (`/etc/init.d/tunnel-server-hysteria2`,
  as root so that it can read the certificate's private key), apart from the `sing-box`
  service of the `sing-box` package, which stays disabled as installed. A change of the
  generated file restarts it; the server off removes the file and stops it.
- `/etc/config/firewall`: the rule `tunnel_server_hysteria2` (UDP from WAN to the port) while
  the server runs.

The generated configuration: `log` at level warn; one `hysteria2` inbound on `::` with the
profiles as users, TLS with the chosen certificate and ALPN `h3`, the optional `obfs` and
`masquerade`; a `direct` outbound; route rules that sniff the protocol, reject BitTorrent
and, with local access off, private address ranges. **Show configuration** in the overview
displays the file; **Show log** the sing-box messages from the system log;
**Restart sing-box** restarts the service.

## Removal

`apk del luci-app-tunnel-server-hysteria2` removes the firewall rule and the generated
configuration, stops sing-box and removes the files. `/etc/config/tunnel-server-hysteria2`
stays unless `apk` is told to drop configuration files.
