# luci-app-tunnel-client-xray

VLESS client links for the **Tunnel → Clients** page
([`luci-app-tunnel-clients`](../luci-app-tunnel-clients/README.md), installed with this
package): the `vless://` links the Xray server page of this repository shows, or links of any
other Xray server. Every link is a client of that page; the section of this package at the
bottom of the page is where links are added.

## What it does

- **Links.** `/etc/config/tunnel-client-xray` holds one `link` section per link: the name,
  the link, on/off and an optional URL for the speed test (by default the server's own site
  through the tunnel, `https://127.0.0.1/cgi-bin/speed`).
- **No process of its own.** `sync` turns every link into an xray outbound (tag
  `xray-<section>`) and writes them to the runtime descriptor
  `/tmp/tunnel-clients/tunnel-client-xray.json`. The outbounds run inside the xray process
  of the Clients page, which rebuilds and tests its configuration whenever the descriptor
  changed. A link with an error is left out, and the error is shown next to it.
- **Supported in a link:**

  | Parameter | Values |
  |---|---|
  | `type` | `tcp` (`raw`), `xhttp` (`splithttp`), `ws`, `grpc`, `httpupgrade` |
  | `security` | `reality` (`pbk`, `sid`, `sni`, `fp`, `spx`), `tls` (`sni`, `fp`, `alpn`), `none` |
  | `flow` | `xtls-rprx-vision`, with `type=tcp` only |
  | `encryption` | `none` or a VLESS encryption string, passed to xray as is |
  | XHTTP | `path`, `mode`, `host`, `extra` (a JSON object) |
  | WS, HTTPUpgrade | `path`, `host` |
  | gRPC | `serviceName`, `mode=multi` |

  Not supported: TCP header obfuscation (`headerType=http`) and `allowInsecure=1`: xray has
  no switch for an unchecked certificate, so a TLS server needs a valid one.

## Removal

`apk del luci-app-tunnel-client-xray` removes the descriptor, and the Clients page drops
these clients. `/etc/config/tunnel-client-xray` stays unless `apk` is told to drop
configuration files.
