# luci-app-xtunnel

One package with three LuCI pages in the **XTunnel** section of the top menu:

- **XTunnel → Dynamic DNS**: keeps your domain names pointed at the router (dynamic DNS), issues
  and renews Let's Encrypt certificates for each of them and serves your own web site over HTTPS
  straight from the router.
- **XTunnel → Server**: one xray process serves up to three transports to devices with a
  profile's links, and the router's tor makes the router reachable through an onion address
  (SSH, the web interface and the VLESS transports), without a public address or open ports.
  The profiles hold the keys for both.
- **XTunnel → Client**: the devices connected to the router reach the Internet through tunnel
  clients, the links of servers, directly or through Tor.

The server and the client share one xray process, the onion service and the client's links
through Tor share one tor. It replaces the packages `luci-app-tunnel-ddns`, `-server`, `-client`
and `-tor` of this repository, which are not installed together with it.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the entries appear in the **XTunnel** section.

## Dynamic DNS and the web site

The page **XTunnel → Dynamic DNS**: keeps your domain names pointed at the router
(dynamic DNS), issues and renews Let's Encrypt certificates for each of them and serves your
own web site over HTTPS straight from the router.

### What it does

- **Domains.** Any number of domains at different providers at the same time. Every domain
  has its own credentials and its own certificate. Every 10 minutes from cron, when an uplink
  comes up and after Save & Apply, `/usr/libexec/xtunnel-ddns/update` compares the router's
  public IPv4 address (the address service, `ip_url`) with the domain's DNS record and with the
  address it sent last; the provider's API is called only when they differ, and every 72 hours
  anyway. The check runs and exits: nothing stays in memory between the runs. Providers:
  DuckDNS, dynv6, IPv64, DNSExit, MyDNS.JP, Beget, Cloudflare (an existing A record of the name;
  the zone from its ID or found from the name's parents).
- **Certificates.** Let's Encrypt through uacme with DNS-01 validation (the provider creates
  the TXT record `_acme-challenge.<domain>`), an account without e-mail, no port has to be
  open for issuing. Before Let's Encrypt is asked to look, the router waits until every
  authoritative name server of the zone answers with the record (at most 7 minutes; when they
  do not answer queries from the router, two minutes). Renewal is automatic: a nightly cron
  job runs uacme, which renews when the certificate is due (Let's Encrypt's renewal window or
  30 days before expiry), and the web server reloads it. The HTTP requests of this part go
  through `uclient-fetch` of the stock image, and the certificates come from `uacme` (no
  acme.sh, wget or openssl).
- **Web site.** Upload a `.tar.gz` archive, pick a domain, tick a box. The router serves the
  site on its HTTPS port and opens that port from WAN. The LuCI administration stays at
  `/cgi-bin/luci/`. The site gets the certificate of its domain on its own.
- **Changing the site's domain** (another domain chosen, the hostname of its domain edited, the
  domain removed) never cuts off the browser that makes the change: the web server keeps the
  certificate it presents during the apply, so LuCI's confirmation of the apply goes through.
  Afterwards the router requests a certificate for the new name if it has none (a test one
  with the test server ticked, else a trusted one) and waits until the name points to this
  router. Then, while a page of the package is open, it presents the new certificate, and the
  page calls the router under the new name (`move_confirm`, with its LuCI session); only that
  call keeps the new name. Without it within 90 seconds (the browser does not resolve the
  name to this router yet, for example) the router goes back to the certificate of the old
  name, the page shows why, and the next attempt follows 10 minutes later. The page then goes
  to the new address by itself. A move from the router's own certificate, or from a name
  without a valid certificate or no longer pointing to this router, needs no open page. A
  test certificate never replaces a trusted one: issued for a name with a trusted certificate
  in use, it is kept apart. While the site is off, the router's pages keep the certificate too.
- **Port.** The site's HTTPS port is configurable (443 by default). It is the port of the one
  uhttpd instance, so LuCI stays on it too.
- **Sites with their own build.** A site may carry a build script (for example one that fetches
  news and regenerates the page). The router runs it right after the upload, on a cron
  schedule set in the administration and on the "Rebuild now" button.
- **Own login page.** A site may bring its own login page; it replaces the standard LuCI
  login while the site is on. The package gives it a captcha generated on the router and a
  brake on password guessing.

The built-in site `default` (served while it is the selected site) is a detailed guide to
writing a site for this package: frontend, backend, login page, archive.

### Providers and what they need

| Provider | Host name | Form fields and where to get them |
|---|---|---|
| DuckDNS | `name.duckdns.org` | **Token** from the duckdns.org account page |
| dynv6 | a zone, e.g. `name.dynv6.net` | **HTTP token**: dynv6.com → Keys |
| IPv64 | `name.ipv64.net` and 18 more domains | **Dynamic DNS key** and **API key**: ipv64.net → Account |
| DNSExit | `name.linkpc.net`, `publicvm.com`, … | **Login**, **Password**, **API key** (Settings → DNS API Key) |
| MyDNS.JP | `name.mydns.jp` | **Master ID** and **Password** from the registration e-mail |
| Beget | any name in your domain on Beget's name servers | **Login** and **API password** (Account settings → Access restriction; the "DNS" group is enough) |
| Cloudflare | any name in your zone | **API token** with Zone → DNS → Edit and the **Zone ID** from the zone page |

DuckDNS, dynv6, IPv64 and DNSExit give a host name for free. DuckDNS, dynv6 and IPv64 names
do not expire. MyDNS.JP deletes the records after a month without address updates; the
package sends them at least every 72 hours, so an enabled domain is safe.

### Step by step

1. **Domains → Add domain…** Enter the host name, choose the provider, fill in its fields.
   Tick **Use the Let's Encrypt test server** the first time: browsers do not trust a test
   certificate, but issuing one does not count against the Let's Encrypt limits. **Save** in
   the dialog, then **Save & Apply** at the bottom of the page.
2. Half a minute later the **Dynamic DNS** column shows "Points to this router ✔". If not,
   open the domain → **Logs** tab → **Show log** next to Dynamic DNS log.
3. **Issue certificate.** Issuing runs in the background for one to three minutes (longer
   with Beget: the package waits 150 seconds for their name servers). The result shows in
   the **Certificate** column, the details in **Logs** → Certificate log. Once it works, untick
   the test server, **Save & Apply** and click **Issue certificate** again for a real
   certificate.
4. **Web site.** Tick **Serve the web site**, choose the **Domain** and the **Site**,
   **Save & Apply**. The site is served at `https://domain/` with that domain's certificate,
   requested on its own if the domain has none yet. To move the site to another name, choose
   (or add) that domain, or edit the hostname, and **Save & Apply**, and keep the page open:
   the overview shows the move, and the page goes to the new address when the site has moved.
   Your own site is uploaded with **Upload a site archive…**: a `.tar.gz` with `index.html` at
   the top level or inside a single folder. The site name is taken from the archive name.
   The **HTTPS port** is changed with **Change…** (see below).
5. **Switch everything off** stops the address updates, closes the HTTPS port, returns the
   web server to its stock pages, removes the renewal and rebuild cron jobs and the login
   page. Certificates, sites and settings stay, so everything can be switched on again.

If the router sits behind another router or behind the provider's NAT, the site is reachable
from outside only after TCP 443 is forwarded to the router. Issuing certificates and updating
the address do not depend on that.

### Bandwidth test endpoint

The built-in site carries `cgi-bin/speed`: `GET /cgi-bin/speed?bytes=N` answers with N zero
bytes from `/dev/zero` (default 5 000 000, at most 20 000 000), nothing is stored on the
router. It is there to measure the throughput of a path to this router from wherever the
request is made, for example `curl -o /dev/null -w '%{speed_download}\n'
'https://<host>/cgi-bin/speed?bytes=5000000'`. It needs no login and answers anyone up to the
cap; a site of your own offers it by shipping the same file in its `cgi-bin/`.

### HTTPS port

The site's port (also the LuCI port, there is one uhttpd) is changed in the **Web site**
section with the button next to **HTTPS port**. It applies at once and apart from
**Save & Apply**: the web server restarts on the new port, and if you are in LuCI through the
old port, reconnect with the link from the dialog (`https://<address>:<port>/cgi-bin/luci/`).
A separate button is needed because LuCI's normal apply confirmation reconnects on the old
port and would roll a port change back.

### Sites with their own build

Besides the public files, the archive may contain a `.xtunnel-ddns/` directory with an
executable file `build` and whatever it needs. The package keeps this directory outside the
web root and runs `build` in it with these environment variables:

```
SITE_NAME    the name of the site
SITE_PUBLIC  the document root (/usr/share/www/<name>), where the pages are written
SITE_TMP     a scratch directory kept between runs (under /tmp, lost on reboot)
```

The build runs right after the upload, on the schedule and on the button. For such a site
the **Web site** section shows the **Rebuild schedule** field (a cron time, five fields; empty
means only on the button) and **Build** with the buttons **Rebuild now** and **Show log**. The schedule
line lives in `/etc/crontabs/root`; the log of the last build in
`/tmp/xtunnel-ddns/` (lost on a reboot), its result in `/etc/xtunnel-ddns/state/`.

### Own login page

If the archive has `cgi-bin/login`, then while this site is on the router is entered only
through that page: a request to `/cgi-bin/luci/…` without a session gets the site's 404
page like any other missing address (only a JSON-RPC request from LuCI's own pages gets
the "login required" answer LuCI expects), the standard LuCI form is never shown, and the
direct JSON-RPC endpoint `/ubus` is switched off (LuCI falls back to its own RPC path
through `/cgi-bin/luci`, which sits behind the same check). After a login `/cgi-bin/luci/`
opens; after a logout from LuCI the site root. Switching the site off puts everything back.
The LuCI dispatcher in `/www/cgi-bin/luci` is not modified: a link to the package's
`luci-gate` is placed into the site's document root, and it lets a request through to LuCI
only with a valid session. LuCI's JSON-RPC calls on that path (the pages poll the router
through them) are answered by the package's `luci-rpc` with the same checks as LuCI's own
handler (the session given in each call, access per object and method), without starting the
whole dispatcher for each call (about 12 ms per call instead of 47, measured on the router).

The page itself gets two ucode modules from the package:

```
import { create, verify } from 'xtunnel-ddns.captcha';
let c = create({ language: 'en' });   // { id, png }: a base64 PNG (coloured letters and digits,
                                      // tilt, wave, noise); 'en' or 'ru'; null when too many
                                      // pictures are waiting for an answer
verify(c.id, text)                    // true when text is the answer; checked once; case and
                                      // Latin/Cyrillic look-alikes do not matter

import { login } from 'xtunnel-ddns.login';
login({ username, password, client: REMOTE_ADDR, https: true })
  // { cookie }                     logged in: send Set-Cookie and redirect to LuCI
  // { error: 'throttled', wait }   after three failures from an address: a 30 s pause,
  //                                doubling up to 15 minutes
  // { error: 'denied' }            wrong user name or password
```

The picture is assembled on the router without image libraries (a bitmap font in
`/usr/share/xtunnel-ddns/captcha-font.json`, the PNG is written by the module itself); the
answer is kept in `/tmp/xtunnel-ddns/captcha/` for three minutes. The package neither checks
nor sets the root password: without one rpcd accepts any password, so set it in
**System → Administration**.

## Server

The page **XTunnel → Server**: one xray process on the router serves up to three transports.
Devices with a profile's links connect to it over the Internet and use the router's connection.

| Transport | Protocol | Port (default) |
|---|---|---|
| TCP + XTLS-Vision | VLESS + REALITY over TCP | TCP 443 |
| XHTTP | VLESS + REALITY over XHTTP | TCP 8443 |
| Hysteria2 | Hysteria2 over QUIC | UDP 443 |

### What it does

- **REALITY** for the two VLESS transports: connections without a valid client key are
  forwarded to the target, a site that answers over TLS 1.3, so no certificate of its own is
  needed. The natural target on this router is its own HTTPS site of the
  [Dynamic DNS page](#dynamic-dns-and-the-web-site) (`127.0.0.1:443`, server name =
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
  VLESS transports, a password for Hysteria2 and a key for the onion service (all generated,
  all editable) and works on every enabled transport. The **Links** button shows one link and
  QR code per transport, ready for v2rayNG, Hiddify, Streisand, NekoBox, the Hysteria2 apps and
  the [Client page](#client) of another router, the links through Tor and the Tor key.
- **Links through Tor.** While the onion service (section **Tor**, tab **Onion service**) is on, **Links**
  also gives *TCP + Vision through Tor* and *XHTTP through Tor*: the same VLESS links with the
  onion address and the transport's own port (the onion service passes each of its ports to
  the same port of the router, so the transport's port has to be among them: 443 for Vision,
  8443 for XHTTP by default). They work without a public address or open ports; a client needs
  the profile's Tor key too (tab **Tor key**). The [Client page](#links-through-tor) of
  another router takes both. Tor carries TCP only, so there is no Hysteria2 link through Tor.
- **Keys** are generated on the router (`xray x25519`) with one button; the public key is
  shown next to the private one. Short IDs, the XHTTP path and the obfuscation password get
  random values with a button too.
- **Firewall.** While the server runs, the ports of the enabled transports are open from WAN
  (one rule per transport). Switching the server off closes them.
- A transport switched off keeps its settings (ports, path, certificate, obfuscation password),
  so its links work again when it is switched back on.
- **Access to local networks.** A box that decides whether clients may reach the router
  itself and the networks behind it through the server, or the Internet only. BitTorrent
  traffic is always dropped.

### Step by step

The page shows the **Overview** and the **Profiles** first, then the settings: **REALITY**,
**Transports** (a tab per transport), **Clients** and **Tor** (tabs **Onion service** and
**Connection to the Tor network**).

1. **REALITY.** Enter the **Target** and the **Server names** (for the router's own site:
   `127.0.0.1:443` and the site's domain), click **Generate keypair** next to the private key
   and **Add a random short ID**.
2. **Transports.** Leave **TCP + XTLS-Vision** on TCP port 443, or pick another port; tick
   **Enabled** in the tabs **XHTTP** and **Hysteria2** if you want them. For Hysteria2 choose the **Certificate**:
   a domain from the Dynamic DNS page (it must have a certificate already) or files on the
   router with the TLS server name. If a router in front forwards a different public port,
   enter it under **Port in client links**.
3. **Clients → Address in the links**: the public name or IP address of the router (a domain from
   the Dynamic DNS page). With the `xtunnel-ddns` site on, the site's domain is used when
   the field is empty.
4. **Profiles → Add profile…**, give it a name (the UUID and the Hysteria2 password are
   filled in), **Save** in the dialog.
5. Click **Turn the server on** in the overview (it saves and applies the page like **Save &
   Apply**). The overview shows "Running" and the open ports a few seconds later; the same
   button then reads **Turn the server off**.
6. **Links** next to a profile: pick the transport, copy the link or scan the QR code in the
   client app. With the onion service (section **Tor**) on, the links through Tor are there
   too; a transport whose port the onion service does not have shows that reason instead.
   **Copy all** copies every link and the Tor key, one per line, for the Client page of another
   router (**All links at once** in the dialog of a profile there).

If the router sits behind another router or behind the provider's NAT, the ports must be
forwarded to it (or opened through UPnP) before clients from the Internet can connect.

Changing the private key, a short ID, a port, the path, a password or the address breaks the
existing links of the transports concerned: export them again.

#### The server on port 443

The default layout is **TCP + XTLS-Vision** on TCP 443 in front of the router's site, with
the target `127.0.0.1:443`, and **Hysteria2** on UDP 443 next to it. When the Dynamic DNS
page serves the router's site, its part sees from the server's configuration in effect that
the TCP port is taken by a VLESS transport, moves the web server to `127.0.0.1:4443` (HTTPS
only; port 80 stays) and leaves the firewall rule for the port to the server's; the target
`127.0.0.1:443` is read as "this router's site" and the generated configuration points at
`127.0.0.1:4443`. Browsers that open the router's domain on 443 are passed through to the
site unchanged, with its Let's Encrypt certificate. Hysteria2 on UDP 443 does not take the
site's port. Switching the server off (or moving the VLESS transports to other ports) puts
the web server back on 443 and its rule back. The hand-over happens inside `sync`: when the
TCP ports of the VLESS transports change, a running xray is stopped before the Dynamic DNS
part is reloaded, so the port is free for whichever of the two has to take it, and
xray starts again right after.

### Tor and the onion service

The section **Tor** of the Server page configures the router's tor in two tabs. **Connection
to the Tor network**: how tor connects to the Tor network (bridges, snowflake, the country for
the bridge updates, the cache, the padding), with its state and tools; tor runs while the onion
service is on or **XTunnel → Client** uses links through Tor, and these settings apply to both.
**Onion service**: the router as an onion service with client authorization, its ports and the
names for tor clients. Only the profiles
with a Tor key can use the address: for everyone else it does not exist. tor lets every client in
to an onion service without authorized clients, so the service is published only while an enabled
profile has a Tor key (the page says "Not published" otherwise, and the address stays for later).

- **An onion service** (version 3) on the router's own tor, with client authorization: the
  address is `<56 characters>.onion`, created on the first start and kept in
  `/etc/tor/xtunnel-tor`. Every port in the **Ports** list leads to the same port on the
  router itself; the default list is 22 (SSH), 80 (the web interface or the site), 443
  (the site over HTTPS, with the Xray server in front of it when it runs) and 8443 (XHTTP).
- **Bridges.** The router's tor connects to the Tor network by itself; where direct
  connections are blocked, it goes through bridges. **Built-in bridges** starts from the
  bridges shipped with the package (`/usr/share/xtunnel-tor/bridges.txt`: the bridges
  `bridges.torproject.org` handed out for the country ru when the package was built — obfs4,
  webtunnel and snowflake lines — then Tor Browser's built-in snowflake and obfs4 bridges). With
  a **Country for bridges** set, the
  router refreshes that list once a day, on **Update bridges** and, while the list shipped with
  the package is in use, as soon as tor has a working circuit (again every 30 minutes until an
  update succeeds): it asks `bridges.torproject.org` (the moat API, what Tor Browser's connection
  assist uses) for the bridges handed out in that country, through its own Tor connection
  (directly if tor is not connected), and merges them into the list, newest first, up to 12
  per transport. tor restarts with the new list only when the answer did not come through tor
  itself: a tor that carried the request works and keeps its bridges until its next start.
  **Bridges entered below** takes the lines from bridges.torproject.org or the Telegram bot
  @GetBridgesBot; **No bridges** connects directly.
- **Snowflake bridges** (built-in or entered lines): **Only when no other bridge works** (the
  default), **Always** or **Never**. Snowflake reaches the Tor network through volunteer
  proxies found by a broker and keeps trying new proxies, which costs traffic. In the default
  mode the configuration holds only the other bridges; every 2 minutes
  `/usr/libexec/xtunnel-tor/watch` asks tor through its control port (127.0.0.1, cookie
  authentication) whether it has a working circuit and through which bridges its circuits go.
  After 6 minutes without a working circuit while the router has a default route (a bootstrap
  that advances counts as working), the snowflake lines are added and tor restarts. They are
  held back again after 30 minutes of circuits through the other bridges, 24 hours after they
  were added, or when the daily bridge update brings a changed list. A list of snowflake lines
  only is used as it is.
- **Uplink changes.** When an interface of the firewall zone `wan` comes up, goes down or
  changes its addresses (a cable pulled or plugged, a USB modem as the second uplink) and the
  route to the Internet now leaves through another interface or address, the package tells tor
  `DisableNetwork 1` and `0` through its control port: tor closes its connections, which are
  still bound to the old address, and connects again through the route in effect. Without it,
  tor noticed nothing for 7 minutes after the WAN cable was pulled and for more than 8 after it
  was plugged back, and the onion address did not answer meanwhile; with it, the onion service
  had its introduction circuits back after 10-20 seconds and its descriptor uploaded after 30-40.
- **Traffic options.** **Keep tor's cache on the router's storage** moves tor's data
  directory (about 33 MB, mostly the relay descriptors) from `/var/lib/tor` in the memory to
  `/etc/tor/xtunnel-tor-data`, so that tor does not download the directory again after a
  restart of the router (about 17 MB each time); tor rewrites the consensus there every few
  hours (about 3 MB). **Less padding traffic** sets tor's `ReducedConnectionPadding` and
  `ReducedCircuitPadding`: idle connections to relays are closed sooner, less padding is sent
  on the connections and only the circuit padding machines with a low overhead are used (the
  tor manual offers these options for clients on links where traffic is expensive).
- **The profiles' Tor keys.** Every profile of the server has, next to its UUID and Hysteria2
  password, an x25519 key for the onion service (**Tor key** in its dialog; generated on the
  router when the profile is added, or by **Generate**; empty: no access through the onion
  address). The router keeps the private key in `/etc/config/xtunnel-server` and installs the
  public key into the service for every enabled profile. **Links** next to a profile has a tab
  **Tor key**: the onion address and the line `<address>:descriptor:x25519:<key>` that
  **XTunnel → Client** of another router takes, the key for Tor Browser's prompt, and for a tor
  daemon (Orbot, or a tor in front of an SSH or Xray client) its torrc lines and the one-line
  `.auth_private` file, plus a QR code of the line.
- **Names for clients.** Names such as `router-home` under which a tor daemon opens the router:
  the torrc lines of **Tor key** then include `MapAddress router-home.onion <address>.onion`, and
  the client connects to `router-home.onion` instead of the 56-character address. The names
  are used by the clients only; the router's own tor does not change with them.
- **No firewall changes.** The router makes the connections itself; nothing is opened from
  WAN. The onion address works behind any NAT.
- **Links through Tor.** While the onion service is on, **Links** also gives *TCP + Vision
  through Tor* and *XHTTP through Tor*: the VLESS links with the onion address and the
  transport's own port (the onion service passes each of its ports to the same port of the
  router, so the transport's port has to be among them: 443 for Vision and 8443 for XHTTP are in
  the default list). Tor carries TCP only, so there is no Hysteria2 link through Tor.

#### Step by step

1. **Tor → Connection to the Tor network → Bridges**: leave **Built-in bridges** and enter the
   **Country for bridges** (two letters) so that the list stays current, or enter your own lines.
2. **Tor → Onion service**: tick **Run the onion service**; leave the **Ports** list as it is or add
   the ports you need.
3. **Profiles**: every profile added has a Tor key filled in; profiles from before have none
   until you click **Generate** in their dialog.
4. Click **Save & Apply** (or the button that turns the server on, which saves and applies the
   page too). The tab **Connection to the Tor network** shows tor connecting and then
   "connected"; the onion address appears right away, the service answers a minute or two
   after the connection is made.
5. **Links** next to a profile, tab **Tor key**:
   - **Tor Browser**: open `http://<address>.onion/` (or `https://<address>.onion/` for 443);
     when it asks for the key of the onion service, paste the key.
   - **A tor daemon** (a computer, a server, Orbot): add the torrc lines shown
     (`ClientOnionAuthDir`, and `MapAddress` for each of the **Names for clients**), put the
     line shown into the file `<name>.auth_private` in that directory, restart it, and connect
     through its SOCKS port: `ssh -o ProxyCommand='nc -x 127.0.0.1:9050 %h %p' root@<name or address>.onion`,
     or point an Xray client at `<name or address>.onion:443` through that proxy.
   - **XTunnel → Client of another router**: paste the links through Tor and the line of the
     Tor key into a profile there and tick **Through Tor** ([Links through Tor](#links-through-tor)).

Switching a profile off (or deleting it, or clearing its Tor key) locks its key out at the next
apply; the address stays the same. A new key means the client has to get the new key.

## Client

The page **XTunnel → Client**: the devices connected to this router (by cable or Wi-Fi) reach the
Internet through tunnel clients. A profile holds the links of one server, one per transport, as
the [Server page](#server) of another router shows them:

| Transport | Link |
|---|---|
| TCP + XTLS-Vision | `vless://` with `type=tcp` and `flow=xtls-rprx-vision` |
| XHTTP | `vless://` with `type=xhttp` |
| Hysteria2 | `hysteria2://` or `hy2://` |
| TCP + XTLS-Vision through Tor | the same `vless://` link to the server's onion address |
| XHTTP through Tor | the same `vless://` link to the server's onion address |

The links through Tor reach a server that has no public address or open ports, through its
onion service: see [Links through Tor](#links-through-tor).

Links of the same kinds from any other Xray or Hysteria2 server (a VPS, another router) work
too. Every link is a client; one of them is active, chosen by hand or automatically by the
measured speed. The traffic of the LAN is split by a list of domains and subnets, and nothing
of it bypasses the clients (kill switch). All clients run in one xray process, the same one as
the server's.

### What it does

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
  or **everything except the list**, or everything with the splitting off (the list and the mode
  stay for when it is switched on again). The list holds your
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
  other; the fastest becomes active (with **Switch when faster by** set, only when it is faster
  than the active one by that much), and at once when the active one failed. Every minute the active link gets a small request (a HEAD
  request to its test URL, or one byte from the server's site, about 12 KB with the
  handshakes); when it does not answer, the other links get the same request and the one that
  answers first becomes active. By hand or with a single link nothing runs on its own (**Measure
  now** still works), and the periodic measurement does not run while the router's default
  route goes through an interface of **Metered uplinks**. After every start of xray (the boot,
  the client switched on, a changed configuration of the client or of the server that shares
  the process) all links are measured and the fastest becomes active, on a metered uplink too;
  without a route to the Internet yet the minute check makes this measurement once one exists,
  and again every minute while no link answers. Switching goes through the control socket of
  xray, without a restart. The test target is the
  server's own site through the tunnel, `https://127.0.0.1/cgi-bin/speed?bytes=N`, served by
  the site of the [Dynamic DNS page](#bandwidth-test-endpoint)
  on the server (with access to local networks allowed there); a profile may name another URL
  for servers that do not have it, and its download is cut off after the test size.
- **Links that are refused:** VLESS over other transports (WebSocket, gRPC and others), TCP
  header obfuscation, an unchecked TLS certificate (`allowInsecure=1`, or `insecure=1`
  without `pinSHA256` for Hysteria2: xray has no switch for an unchecked certificate),
  Hysteria2 port ranges, an `.onion` address in a field that is not through Tor, and HTTP/3
  (`alpn=h3`) through Tor. The reason is shown next to the link.

### Links through Tor

A server router whose onion service is on (its Server page, section **Tor**, tab **Onion service**) is
reachable through its onion address without a public address or open ports (behind a mobile
operator's NAT, for example). **Links** next to a profile on its Server page then gives *TCP +
Vision through Tor* and *XHTTP through Tor* next to the other links, and the tab **Tor key** the
line of the profile's key: the onion service lets in only clients with a key.

- A profile holds them next to the direct links: the fields **TCP + Vision through Tor
  link** and **XHTTP through Tor link**, the **Onion service key** (the whole line of the Tor
  key, `<address>:descriptor:x25519:<key>`) and the box **Through Tor**, which decides whether
  they are used; switched off, they are kept but left out.
- The links through Tor are clients like the others: measured, checked every minute (with 30
  seconds for an answer instead of 10) and chosen by hand or automatically. When the direct
  links of a server stop answering (its cable out, the server on a mobile uplink), the minute
  check makes the link through Tor that answers first active, and the measurements then
  choose the faster of the links through Tor; when the direct links answer again, the next
  measurement goes back to the fastest. Measured between two test routers in Docker over the
  Tor network: 40-430 KB/s through Tor against tens of MB/s directly, 1-7 s to the first byte.
- xray dials them through the SOCKS port of this router's tor, `127.0.0.1:9050` (tor's
  default). tor runs while they are in use, with the connection settings of this router's
  Server page (section **Tor**: bridges and so on); the overview shows its state.
- The keys go to tor with the rest of its configuration (see **Tor** under "What the package
  changes"): `/etc/tor/xtunnel-client/<profile>.auth_private` (owned by tor's user) and
  `ClientOnionAuthDir /etc/tor/xtunnel-client` in `/etc/xtunnel-tor/torrc`. tor reads the keys
  only when it starts, so a new, changed or removed key (also the client switched on or off,
  or **Through Tor** switched) restarts tor; meanwhile the router's own onion service is
  unreachable for some minutes, and the onion connections fail at once for about a minute
  after a few restarts in a row.
- Tor carries TCP only, so there is no Hysteria2 link through Tor. The names of the servers
  of the links through Tor are resolved by tor, not at the provider.

### through Tor

**Settings**, tab **through Tor**, **Enabled** adds one more link: the outbound `tor` itself (the SOCKS
port of this router's tor), so the LAN goes through the Tor network and out of its exit relays,
without a server. It is measured, checked and chosen like the other links. Its test target is
`cgi-bin/speed` of the site this router serves (the Dynamic DNS page), at the site's domain and
port, through Tor; **URL for the speed test through Tor** names another one (a router in front
that forwards another public port to the site, or another site). Without a site and without a
URL the link is marked and not used. Tor carries TCP only: UDP of the LAN (QUIC, calls) does not
pass while it is active, and the resolver of **DNS through the tunnel** is asked over TCP while
the link is on.

### Step by step

1. Install the package, log in to LuCI again, open **XTunnel → Client**.
2. **Profiles → Add profile…**, give it the server's name and paste its links from the
   server page (**Links** next to a profile there), **Save**. Repeat for every server. For a
   server with an onion service also paste its links through Tor and the line of its tab
   **Tor key**, and tick **Through Tor**. Quicker: **Copy all** in that **Links** dialog, paste
   into **All links at once** of the profile's dialog and click **Fill in the fields** (each link
   goes into the field of its transport, the Tor key into **Onion service key**, **Through Tor**
   is ticked when there are links through Tor).
3. Check the **Split tunnelling** section: the mode, your entries, the sources.
4. Click **Turn the client on** in the overview (it saves and applies the page like **Save &
   Apply**; **Turn the client off** switches it off the same way). The overview shows the
   service running and the links ready; **Measure now** fills the speeds and, in the
   automatic mode, picks the fastest.
5. By hand: choose **By hand**, pick the **Active link** (or **Choose** in the table) and
   apply.

## What the package changes on the router

Everything only on **Save & Apply** (or the on/off buttons of the pages), nothing at install
time with the default configuration.

### Dynamic DNS and the web site

Everything only on **Save & Apply** or on a button, nothing at install time with the default
configuration. On a reinstall or upgrade the package's init script is started by apk, so an
existing configuration is applied again right away (useful after `apk del`, which switches
everything off).

- With a VLESS transport of the server (XTunnel → Server) running on the site's
  HTTPS port (TCP 443 by default), the site is served behind it: uhttpd listens for HTTPS on
  `127.0.0.1:4443` only, the port is opened by the server's firewall rule, and the overview
  says so. xray passes every connection without a client key through to the site; the site's
  own login page and LuCI work the same way. Hysteria2 listens on UDP and does not take the
  site's port. The decision is taken from the server's configuration file in effect
  (`/etc/xtunnel-server/config.json`) on every `sync`, which the server's `sync` runs after
  each change of its own.

- `/etc/config/ddns`: the sections `xtunnel_ddns_<id>` an earlier version kept for
  ddns-scripts are removed (`ddns` is restarted then).
- `/etc/config/firewall`: the rule `xtunnel_ddns_https` (TCP to the chosen port from WAN)
  while the site is on.
- `/etc/config/uhttpd`: `home`, `cert`, `key`, `listen_https` (the port), `no_dirlists` and,
  when the site has a `404.html`, `error_page` of the main instance while the site is on; for a site with its own login page
  `ubus_prefix` is removed as well (see below). `/etc/config/luci`: `resourcebase` and
  `mediaurlbase` point at the link described next, and with a login page `ubuspath` at the
  RPC path through `cgi-bin/luci`. The original values are kept in
  `/etc/xtunnel-ddns/uhttpd.backup` and restored when the site is switched off. Links to every
  `/www/cgi-bin/*` entry and, under a random name kept in `/etc/xtunnel-ddns/static.name`, to
  `/www/luci-static` are added to the site's directory so that LuCI stays reachable without
  its name showing up in the site's address space; files of the site with those names are
  left alone. The same random-named link is placed under `/www` while a site is served (two
  LuCI pages look their parts up on disk at `/www` + the resource URL); nothing else under
  `/www` is touched.
- `/etc/crontabs/root`: the address check every 10 minutes (while a domain is on), the
  certificate renewal line (as long as there is at least one certificate) and, for a site with
  a build script, the rebuild line on the schedule from the administration.
- `/etc/hotplug.d/iface/90-xtunnel` (one script for the parts that follow the way out): the
  address check 5 seconds after an interface of the wan zone comes up or changes its addresses.
- Uploaded sites: the public files in `/usr/share/www/<name>/`, the archive's `.xtunnel-ddns/`
  directory (the build script and everything for it) in `/etc/xtunnel-ddns/sites/<name>/`.
  The result of a site's last build is kept in `/etc/xtunnel-ddns/state/`.
- Certificates: uacme's account and its copy of every certificate in `/etc/xtunnel-ddns/acme/`
  (staging: `acme-staging/`), the copies for the web server and the server's Hysteria2 in
  `/etc/ssl/xtunnel-ddns/<domain>/fullchain.pem` and `key.pem` (a test certificate kept apart
  from a trusted one: `<domain>/staging/`). The name whose certificate the web server presents:
  `/etc/xtunnel-ddns/site.cert`; the state of a move of the site: `/tmp/xtunnel-ddns/move.json`
  (the open pages: `/tmp/xtunnel-ddns/watch/`, the call under the new name: `move.confirm`). A certificate already installed
  there (from an earlier version with acme.sh, or restored from a backup) is taken into uacme's
  directory before the first renewal, so it is renewed only when due. Beget is used only through
  `dns/changeRecords`, so its API password may be restricted to the "DNS" group.

Logs: `/tmp/xtunnel-ddns/ddns-<id>.log` (address), `/tmp/xtunnel-ddns/cert-<id>.log` (certificate),
`/tmp/xtunnel-ddns/renew.log` (nightly renewals), `logread | grep xtunnel-ddns` (applying the
settings, updates, issued certificates).

### Server

Everything only on **Save & Apply**, nothing at install time with the default configuration.
On a reinstall or upgrade the package's init script is started by apk, so an existing
configuration is applied again right away.

- `/etc/xtunnel-server/config.json` (mode 600): the xray configuration generated from
  `/etc/config/xtunnel-server`, which gets mode 600 as well (it holds the private key, the
  UUIDs and the passwords). The file is replaced only after `xray run -test` accepts it; any
  error, from incomplete settings or a missing certificate to a configuration rejected by
  xray, leaves the configuration in effect running and shows the reason in the overview.
  Only switching the server off stops it.
- xray runs once for the server and the client: `/usr/libexec/xtunnel/xray-service` joins the
  configuration files of the started parts into `/tmp/xtunnel-xray/config.json` (inbounds and
  routing rules added up, every rule bound to the inbounds of its part; xray's own merging of
  several `-config` files is not
  used, it replaces the routing rules of the first file) and runs xray with it as the procd
  service `xtunnel-xray`. The joined file replaces the one in effect only after `xray run -test`
  accepts it. One process instead of two saves about 10 MB of memory (measured on the router:
  13.3 MB of its own memory for both against 13.2 + 12.9 MB as two processes). A change of either file restarts
  it, so a change of the client's settings or its daily list update also restarts the server's
  transports for a moment (clients reconnect); the server off removes its file, and xray goes
  on with the client's alone or stops.
- `/etc/config/firewall`: the rules `xtunnel_server_vision`, `xtunnel_server_xhttp` (TCP) and
  `xtunnel_server_hysteria2` (UDP) from WAN to the transport ports while the server runs.

The generated configuration: `log` at level warning without an access log; one inbound per
enabled transport (`vless` with REALITY, `hysteria` version 2 with TLS and ALPN `h3`) with
`sniffing` for routing only; a `freedom` outbound; a `blackhole` outbound for BitTorrent and,
with local access off, for private address ranges. **Show configuration** in the overview
displays the file; **Show log** the xray messages from the system log; **Restart Xray**
restarts the service.

### Client

Everything only on **Save & Apply**, nothing at install time. While the client is on:

- `/etc/xtunnel-client/config.json` (mode 600): the xray configuration generated from
  `/etc/config/xtunnel-client`, checked with `xray run -test` before it replaces the file in
  effect. xray runs once for the client and the server: `/usr/libexec/xtunnel/xray-service`
  joins the configuration files of the started parts into `/tmp/xtunnel-xray/config.json` (checked
  with `xray run -test` too) and runs xray with it as the procd service `xtunnel-xray`; xray
  restarts only when the joined file changed, and the active link is then applied again. The
  active link is a balancer target switched through the control socket of that xray
  (`/tmp/xtunnel-xray/control.sock`, root only, `xray control`; `xtunnel-core` has no gRPC API);
  the automatic choice is kept in `/etc/xtunnel-client/auto.json`, the
  provider's resolvers of the last uplink in `/etc/xtunnel-client/resolvers` (used at a start
  before an uplink is up). Local ports 61001 (interception), 61002 (the listed subnets), 61053
  (DNS), 61101… (one per link, for the speed test) and 61201… (one per list host) belong to it;
  direct connections from the LAN to them are refused.
- `/etc/config/firewall`: the includes `xtunnel_client` (rules in
  `/etc/xtunnel-client/tproxy.nft`, chain `mangle_prerouting`) and `xtunnel_client_set` (the set
  `xtunnel_client_listed` in `/etc/xtunnel-client/listed.nft`, checked with `nft -c` before it
  replaces the one in effect), and `enabled 0` on the lan → wan forwarding.
- `/etc/config/network`: the rule `xtunnel_client_rule` (fwmark 0x2222 → table 2222) and the
  route `xtunnel_client_route` (local 0.0.0.0/0 in table 2222); for the LAN `ip6assign` removed
  and `wan6` disabled.
- `/etc/config/dhcp`: `dhcpv6` and `ndp` of the LAN set to `disabled`, `ra_default` removed
  (`ra relay` becomes `server`); dnsmasq `noresolv 1`
  and `server 127.0.0.1#61053` (your servers for single domains, `/domain/address`, stay), and
  `localuse 0`: the router's own lookups go to the provider's resolvers directly
  (`/tmp/resolv.conf` → `resolv.conf.auto`), so its services (dynamic DNS, updates,
  certificates) work without the active link, as its own traffic is not intercepted either.
- `/etc/crontabs/root`: in the automatic mode with two links or more the measurement and the
  check every minute, and the daily update of the sources while there are any (`#
  xtunnel-client-…` lines); the file is removed when no other line is left.
- `/etc/xtunnel-client/sources/`: the fetched lists and their `.meta` (the files of a removed
  source go at the next apply); `/tmp/xtunnel-client/`: measurements, history, state.
- While links through Tor are in use, the router's tor runs, and the keys of their onion
  services are in `/etc/tor/xtunnel-client/` (see **Tor** below).

The original values of everything changed are kept in `/etc/xtunnel-client/backup.json` and
restored when the client is switched off.

### Tor

tor is needed while the onion service is on (Server page, section **Tor**, tab **Onion service**) or the client
uses links through Tor; then:

- `/etc/xtunnel-tor/torrc` (root:tor, mode 640): the tor configuration generated from
  `/etc/config/xtunnel-server` (section `tor`; the config gets mode 600, it holds the private
  keys) and `/etc/config/xtunnel-client`: the bridge lines, the traffic options, a control
  port on 127.0.0.1 (`ControlPort auto`, the port written to `control.port` in the data
  directory, `CookieAuthentication 1`) for the watch script and the state on the page, which
  asks tor there for its bootstrap progress; with the onion service the service directory, its
  version and ports; with the client's keys `ClientOnionAuthDir /etc/tor/xtunnel-client`. It is
  added to the stock tor configuration through `tor.conf.tail_include` in `/etc/config/tor`,
  the way the tor package provides for. The file is replaced only after `tor --verify-config`
  accepts it together with the stock `/etc/tor/torrc`; any error, from an unreadable bridge
  line to a configuration rejected by tor, leaves the configuration in effect running and
  shows the reason on the page. When nothing needs tor any more, it is removed.
- `/etc/tor/xtunnel-tor/` (tor:tor, mode 700): the service's keys and `hostname`, kept by tor;
  `authorized_clients/<profile section>.auth` for every enabled server profile with a Tor key,
  written from that key. The directory stays when the service is switched off and when the
  package is removed; deleting it gives the service a new address.
- `/etc/tor/xtunnel-client/` (tor:tor, mode 700): one `<client profile section>.auth_private`
  per client profile whose links through Tor are in use and have a key.
- `/etc/xtunnel-tor/bridges.txt` and `bridges.state`: the refreshed bridge list and the result
  of the last update (time, country, through Tor or directly, counts, error); while tor runs
  with the built-in list and a country, a line in `/etc/crontabs/root` (`# xtunnel-tor-bridges`,
  once a day at a time chosen at random) runs `/usr/libexec/xtunnel-tor/bridges-update`.
- With snowflake as the fallback and a list of snowflake and other lines, and while the list
  shipped with the package is in use with a country set (for the first update), a line in
  `/etc/crontabs/root` (`# xtunnel-tor-watch`, every 2 minutes) runs
  `/usr/libexec/xtunnel-tor/watch`; its last result is in `/tmp/xtunnel-tor/watch.json`, and
  `/etc/xtunnel-tor/snowflake.on` (the time it was written) exists while the snowflake lines are
  added.
- `/etc/hotplug.d/iface/90-xtunnel`: on ifup, ifdown and ifupdate of an interface of the wan
  zone, while tor runs with this package's file, 3 seconds later, `watch reconnect` (one at a
  time); the route in effect is kept in `/tmp/xtunnel-tor/uplink`, and tor is reconnected only
  when it changed.
- `/etc/tor/xtunnel-tor-data/` (tor:tor, mode 700) while the cache is kept on the router's
  storage. When the option is switched on or off, the cache files (`cached-*`, `state`) are
  copied to the other directory before tor restarts, so that tor does not download the
  directory again; afterwards only one copy is kept.
- The `tor` service is restarted on every change (tor re-reads `/etc/tor/torrc` on reload
  as the unprivileged tor user, which cannot read it, so a reload would stop it). The service
  (of `xtunnel-core`, the init script of OpenWrt's `tor` package) is enabled and started when it
  is installed; this package switches the
  service on with its configuration, and when nothing needs tor any more it stops and disables
  the stock service only if it was off before this package switched it on (marker
  `/etc/xtunnel-tor/managed`), otherwise it restarts it without this package's part. **Restart
  tor** in the section **Tor** restarts the service by hand.

The generated configuration and the list of authorized clients: **Show tor configuration** in
the section **Tor**; **Show tor log** shows the tor messages from the system log, including the
bootstrap progress.

## Removal

`apk del luci-app-xtunnel` switches everything off first and then removes the files: the client's
interception, firewall, routing, IPv6, dnsmasq and cron settings are restored, xray stops, the
server's firewall rules go, the tor configuration of the package and its inclusion in
`/etc/config/tor` go (the stock tor service is stopped when this package had switched it on),
and the web server gets its stock settings back. The configuration (`/etc/config/xtunnel-ddns`,
`xtunnel-server`, `xtunnel-client`), the uploaded sites (`/usr/share/www/`,
`/etc/xtunnel-ddns/sites/`), uacme's directories (`/etc/xtunnel-ddns/`, `/etc/ssl/xtunnel-ddns/`),
the client's fetched lists (`/etc/xtunnel-client/`) and the onion service's keys
(`/etc/tor/xtunnel-tor/`) stay. The dependencies installed with the package (xtunnel-core, tor, uacme,
the nftables TPROXY and socket kernel modules, curl) are removed by apk unless another package needs
them.
