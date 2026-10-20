# luci-app-tunnel-client-hysteria2

Hysteria2 client links for the **Tunnel → Clients** page
([`luci-app-tunnel-clients`](../luci-app-tunnel-clients/README.md), installed with this
package): the `hysteria2://` (or `hy2://`) links the Hysteria2 server page of this repository
shows, or links of any other Hysteria2 server. Every link is a client of that page; the
section of this package at the bottom of the page is where links are added.

## What it does

- **Links.** `/etc/config/tunnel-client-hysteria2` holds one `link` section per link: the
  name, the link, on/off and an optional URL for the speed test (by default the server's own
  site through the tunnel, `https://127.0.0.1/cgi-bin/speed`).
- **No process of its own.** `sync` turns every link into an xray `hysteria` outbound
  (version 2, QUIC over UDP; tag `hysteria2-<section>`) and writes them to the runtime
  descriptor `/tmp/tunnel-clients/tunnel-client-hysteria2.json`. The outbounds run inside the
  xray process of the Clients page, which rebuilds and tests its configuration whenever the
  descriptor changed. A link with an error is left out, and the error is shown next to it.
- **Supported in a link:**

  | Parameter | Values |
  |---|---|
  | password | the user part of the link (`hysteria2://<password>@host:port`) |
  | `sni` | the TLS server name, the host of the link when absent |
  | `pinSHA256` | the SHA-256 fingerprint of the server certificate (hex, colons allowed) |
  | `obfs` | `salamander` with `obfs-password` |

  The certificate of the server is checked. A server with a certificate that does not
  verify needs `pinSHA256` in the link: `insecure=1` alone is refused, because xray has no
  switch for an unchecked certificate. Not supported: port ranges (port hopping).

## Removal

`apk del luci-app-tunnel-client-hysteria2` removes the descriptor, and the Clients page drops
these clients. `/etc/config/tunnel-client-hysteria2` stays unless `apk` is told to drop
configuration files.
