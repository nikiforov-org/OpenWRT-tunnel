# luci-app-tunnel_server-xray

The LuCI page **Tunnel → Xray server**: a VLESS + REALITY server on the router. Devices with
a client link connect to it over the Internet and use the router's connection; to anyone
else the port looks like an ordinary HTTPS site.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the entry appears in the **Tunnel** section.

## What it does

- **REALITY.** The server presents the TLS handshake of a real web site (the target): a
  visitor without a client key is simply forwarded there. No certificate of its own is
  needed. The natural target on this router is its own HTTPS site from
  [`luci-app-tunnel_ddns`](../luci-app-tunnel_ddns/README.md) (`127.0.0.1:443`, server name =
  the site's domain); any public site that answers over TLS 1.3 works as well.
- **Two transports**, both VLESS over REALITY, each on its own TCP port: **TCP + XTLS-Vision**
  (the primary one, supported by every current client app) and **XHTTP** (looks like HTTP
  requests; needs a client app with the Xray core). They share the keys, server names, short
  IDs and clients.
- **Profiles.** Any number of clients, one UUID each, switchable on and off. The **Links**
  button shows the `vless://` link and a QR code per transport, ready for v2rayNG, Hiddify,
  Streisand, NekoBox and the like.
- **Keys** are generated on the router (`xray x25519`) with one button; the public key is
  shown next to the private one. Short IDs and the XHTTP path get random values with a
  button too.
- **Firewall.** While the server runs, the ports of the enabled transports are open from WAN
  (one rule per transport). Switching the server off closes them.
- **Access to local networks.** A box that decides whether clients may reach the router
  itself and the networks behind it through the server, or the Internet only. BitTorrent
  traffic is always dropped.

## Step by step

1. **Server.** Enter the **Target** and the **Server names** (for the router's own site:
   `127.0.0.1:443` and the site's domain), click **Generate keypair** and
   **Add a random short ID**.
2. **Transports.** Leave **TCP + XTLS-Vision** on port 8443, or pick another port; switch on
   **XHTTP** if you want the second transport. If a router in front forwards a different
   public port, enter it under **Port in client links**.
3. **Client links → Address**: the public name or IP address of the router (a domain from
   the Dynamic DNS page). With the `tunnel_ddns` site on, the site's domain is used when
   the field is empty.
4. **Profiles → Add profile…**, give it a name (a UUID is filled in), **Save** in the dialog.
5. Tick **Run the server** and click **Save & Apply**. The overview shows "Running" and the
   open ports a few seconds later.
6. **Links** next to a client: copy the link or scan the QR code in the client app.

If the router sits behind another router or behind the provider's NAT, the ports must be
forwarded to it (or opened through UPnP) before clients from the Internet can connect.

Changing the private key, a short ID, a port, the path or the address breaks the existing
links: export them again.

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time with the default configuration.
On a reinstall or upgrade the package's init script is started by apk, so an existing
configuration is applied again right away.

- `/etc/tunnel_server-xray/config.json` (mode 600): the Xray configuration generated from
  `/etc/config/tunnel_server-xray`, which gets mode 600 as well (it holds the private key and
  the UUIDs). The file is replaced only after `xray run -test` accepts it; a rejected
  configuration leaves the running one in place and shows the reason in the overview.
- Xray runs as a procd service of this package (`/etc/init.d/tunnel_server-xray`), apart from
  the `xray` service of the `xray-core` package, which stays disabled as installed. A change
  of the generated file restarts it; the server off removes the file and stops it.
- `/etc/config/firewall`: the rules `tunnel_server_xray_vision` and `tunnel_server_xray_xhttp`
  (TCP from WAN to the transport port) while the server runs.

The generated configuration: `log` at level warning without an access log; one `vless`
inbound per enabled transport with `sniffing` for routing only; a `freedom` outbound; a
`blackhole` outbound for BitTorrent and, with local access off, for private address ranges.
**Show configuration** in the overview displays the file; **Show log** the Xray messages
from the system log; **Restart Xray** restarts the service.

## Removal

`apk del luci-app-tunnel_server-xray` removes the firewall rules and the generated
configuration, stops Xray and removes the files. `/etc/config/tunnel_server-xray` stays
unless `apk` is told to drop configuration files; `xray-core` stays installed.
