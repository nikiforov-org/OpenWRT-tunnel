# luci-app-tunnel-server

The LuCI page **Tunnel → Server**: one xray process on the router serves up to three
transports. Devices with a profile's links connect to it over the Internet and use the
router's connection.

| Transport | Protocol | Port (default) |
|---|---|---|
| TCP + XTLS-Vision | VLESS + REALITY over TCP | TCP 443 |
| XHTTP | VLESS + REALITY over XHTTP | TCP 8443 |
| Hysteria2 | Hysteria2 over QUIC | UDP 443 |

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the entry appears in the **Tunnel** section.

## What it does

- **REALITY** for the two VLESS transports: connections without a valid client key are
  forwarded to the target, a site that answers over TLS 1.3, so no certificate of its own is
  needed. The natural target on this router is its own HTTPS site from
  [`luci-app-tunnel-ddns`](../luci-app-tunnel-ddns/README.md) (`127.0.0.1:443`, server name =
  the site's domain; when the site moves to another name, the overview says so until that
  name is among the server names); any public site that answers over TLS 1.3 works as well.
- **Hysteria2** uses ordinary TLS 1.3 over QUIC, so it needs a certificate for the name clients
  connect to. The easiest source is a domain from the Dynamic DNS page: pick it in the
  **Certificate** field and the transport uses that domain's Let's Encrypt certificate and
  name; when that domain's hostname is edited, the transport takes the certificate of the new
  name as soon as it exists. Certificate files on the router (PEM paths and the TLS server
  name) work as well. xray reads the files again every hour, so renewals need no restart. Optional: **Salamander**
  obfuscation with one shared password, and a **masquerade** for HTTP/3 requests without a
  profile password (a URL to proxy, a directory to serve or an xray masquerade object; by
  default a 404 answer).
- **Profiles.** Any number of profiles, switchable on and off. A profile has a UUID for the
  VLESS transports and a password for Hysteria2 (both generated, both editable) and works on
  every enabled transport. The **Links** button shows one link and QR code per transport,
  ready for v2rayNG, Hiddify, Streisand, NekoBox, the Hysteria2 apps and the
  [Client page](../luci-app-tunnel-client/README.md) of another router.
- **Keys** are generated on the router (`xray x25519`) with one button; the public key is
  shown next to the private one. Short IDs, the XHTTP path and the obfuscation password get
  random values with a button too.
- **Firewall.** While the server runs, the ports of the enabled transports are open from WAN
  (one rule per transport). Switching the server off closes them.
- **Access to local networks.** A box that decides whether clients may reach the router
  itself and the networks behind it through the server, or the Internet only. BitTorrent
  traffic is always dropped.

## Step by step

1. **REALITY.** Enter the **Target** and the **Server names** (for the router's own site:
   `127.0.0.1:443` and the site's domain), click **Generate keypair** and
   **Add a random short ID**.
2. **Transports.** Leave **TCP + XTLS-Vision** on TCP port 443, or pick another port; switch
   on **XHTTP** and **Hysteria2** if you want them. For Hysteria2 choose the **Certificate**:
   a domain from the Dynamic DNS page (it must have a certificate already) or files on the
   router with the TLS server name. If a router in front forwards a different public port,
   enter it under **Port in client links**.
3. **Client links → Address**: the public name or IP address of the router (a domain from
   the Dynamic DNS page). With the `tunnel-ddns` site on, the site's domain is used when
   the field is empty.
4. **Profiles → Add profile…**, give it a name (the UUID and the Hysteria2 password are
   filled in), **Save** in the dialog.
5. Tick **Run the server** and click **Save & Apply**. The overview shows "Running" and the
   open ports a few seconds later.
6. **Links** next to a profile: pick the transport, copy the link or scan the QR code in the
   client app.

If the router sits behind another router or behind the provider's NAT, the ports must be
forwarded to it (or opened through UPnP) before clients from the Internet can connect.

Changing the private key, a short ID, a port, the path, a password or the address breaks the
existing links of the transports concerned: export them again.

### The server on port 443

The default layout is **TCP + XTLS-Vision** on TCP 443 in front of the router's site, with
the target `127.0.0.1:443`, and **Hysteria2** on UDP 443 next to it. When the Dynamic DNS
package serves the router's site, it sees from this server's configuration in effect that
the TCP port is taken by a VLESS transport, moves its web server to `127.0.0.1:4443` (HTTPS
only; port 80 stays) and leaves the firewall rule for the port to this package; the target
`127.0.0.1:443` is read as "this router's site" and the generated configuration points at
`127.0.0.1:4443`. Browsers that open the router's domain on 443 are passed through to the
site unchanged, with its Let's Encrypt certificate. Hysteria2 on UDP 443 does not take the
site's port. Switching the server off (or moving the VLESS transports to other ports) puts
the web server back on 443 and its rule back. The hand-over happens inside `sync`: when the
TCP ports of the VLESS transports change, a running xray is stopped before the Dynamic DNS
package is told to reload, so the port is free for whichever of the two has to take it, and
xray starts again right after.

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time with the default configuration.
On a reinstall or upgrade the package's init script is started by apk, so an existing
configuration is applied again right away.

- `/etc/tunnel-server/config.json` (mode 600): the xray configuration generated from
  `/etc/config/tunnel-server`, which gets mode 600 as well (it holds the private key, the
  UUIDs and the passwords). The file is replaced only after `xray run -test` accepts it; any
  error, from incomplete settings or a missing certificate to a configuration rejected by
  xray, leaves the configuration in effect running and shows the reason in the overview.
  Only switching the server off stops it.
- xray runs once for this package and `luci-app-tunnel-client`: `/usr/libexec/tunnel-server/xray-service`
  (the client package ships the same script) joins the configuration files of the started
  packages into `/tmp/tunnel-xray/config.json` (inbounds and routing rules added up, every rule
  bound to the inbounds of its package; xray's own merging of several `-config` files is not
  used, it replaces the routing rules of the first file) and runs xray with it as the procd
  service `tunnel-xray`, apart from the `xray` service of the `xray-core` package, which stays
  disabled as installed. The joined file replaces the one in effect only after `xray run -test`
  accepts it. One process instead of two saves about 10 MB of memory (measured on the router:
  13.3 MB of its own memory for both against 13.2 + 12.9 MB as two processes). A change of either file restarts
  it, so a change of the client's settings or its daily list update also restarts the server's
  transports for a moment (clients reconnect); the server off removes its file, and xray goes
  on with the client's alone or stops.
- `/etc/config/firewall`: the rules `tunnel_server_vision`, `tunnel_server_xhttp` (TCP) and
  `tunnel_server_hysteria2` (UDP) from WAN to the transport ports while the server runs.

The generated configuration: `log` at level warning without an access log; one inbound per
enabled transport (`vless` with REALITY, `hysteria` version 2 with TLS and ALPN `h3`) with
`sniffing` for routing only; a `freedom` outbound; a `blackhole` outbound for BitTorrent and,
with local access off, for private address ranges. **Show configuration** in the overview
displays the file; **Show log** the xray messages from the system log; **Restart Xray**
restarts the service.

## Removal

`apk del luci-app-tunnel-server` removes the firewall rules and the generated
configuration, stops xray and removes the files. `/etc/config/tunnel-server` stays unless
`apk` is told to drop configuration files.
