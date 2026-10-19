# luci-app-tunnel-ddns

The LuCI page **Tunnel → Dynamic DNS**: keeps your domain names pointed at the router
(dynamic DNS), issues and renews Let's Encrypt certificates for each of them and serves your
own web site over HTTPS straight from the router.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the entry appears in the **Tunnel** section.

## What it does

- **Domains.** Any number of domains at different providers at the same time. Every domain
  has its own credentials and its own certificate. The address is updated through
  ddns-scripts: checked every 10 minutes, sent anyway every 72 hours.
- **Certificates.** Let's Encrypt through acme.sh with DNS-01 validation (the provider
  creates the TXT record), no e-mail needed, no port has to be open for issuing. Renewal is
  automatic: a nightly cron job renews 30 days before expiry and the web server reloads the
  certificate by itself.
- **Web site.** Upload a `.tar.gz` archive, pick a domain, tick a box. The router serves the
  site on its HTTPS port and opens that port from WAN. The LuCI administration stays at
  `/cgi-bin/luci/`.
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

## Providers and what they need

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

## Step by step

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
   **Save & Apply**. The site is served at `https://domain/` with that domain's certificate.
   Your own site is uploaded with **Upload a site archive…**: a `.tar.gz` with `index.html` at
   the top level or inside a single folder. The site name is taken from the archive name.
   The **HTTPS port** is changed with **Change…** (see below).
5. **Switch everything off** stops the address updates, closes the HTTPS port, returns the
   web server to its stock pages, removes the renewal and rebuild cron jobs and the login
   page. Certificates, sites and settings stay, so everything can be switched on again.

If the router sits behind another router or behind the provider's NAT, the site is reachable
from outside only after TCP 443 is forwarded to the router. Issuing certificates and updating
the address do not depend on that.

## What the package changes on the router

Everything only on **Save & Apply** or on a button, nothing at install time with the default
configuration. On a reinstall or upgrade the package's init script is started by apk, so an
existing configuration is applied again right away (useful after `apk del`, which switches
everything off).

- `/etc/config/ddns`: sections `tunnel_ddns_<id>` for every enabled domain; the file gets
  mode 600 (it holds passwords). `ddns` is restarted.
- `/etc/config/firewall`: the rule `tunnel_ddns_https` (TCP to the chosen port from WAN)
  while the site is on.
- `/etc/config/uhttpd`: `home`, `cert`, `key`, `listen_https` (the port), `no_dirlists` and,
  when the site has a `404.html`, `error_page` of the main instance while the site is on; for a site with its own login page
  `ubus_prefix` is removed as well (see below). `/etc/config/luci`: `resourcebase` and
  `mediaurlbase` point at the link described next, and with a login page `ubuspath` at the
  RPC path through `cgi-bin/luci`. The original values are kept in
  `/etc/tunnel-ddns/uhttpd.backup` and restored when the site is switched off. Links to every
  `/www/cgi-bin/*` entry and, under a random name kept in `/etc/tunnel-ddns/static.name`, to
  `/www/luci-static` are added to the site's directory so that LuCI stays reachable without
  its name showing up in the site's address space; files of the site with those names are
  left alone. The same random-named link is placed under `/www` while a site is served (two
  LuCI pages look their parts up on disk at `/www` + the resource URL); nothing else under
  `/www` is touched.
- `/etc/crontabs/root`: the certificate renewal line (as long as there is at least one
  certificate) and, for a site with a build script, the rebuild line on the schedule from the
  administration.
- Uploaded sites: the public files in `/usr/share/www/<name>/`, the archive's `.tunnel-ddns/`
  directory (the build script and everything for it) in `/etc/tunnel-ddns/sites/<name>/`.
  The result of a site's last build is kept in `/etc/tunnel-ddns/state/`.
- Certificates: acme.sh's working files in `/etc/acme/<domain>_ecc/`, copies for the web
  server in `/etc/ssl/tunnel-ddns/<domain>/fullchain.pem` and `key.pem`.
- The `dns_begetdns` hook in `/usr/lib/acme/client/dnsapi/`: it only uses
  `dns/changeRecords`, so the Beget API password may be restricted to the "DNS" group.

Logs: `/var/log/ddns/tunnel_ddns_<id>.log` (address), `/tmp/tunnel-ddns/cert-<id>.log`
(certificate), `logread | grep tunnel-ddns` (applying the settings).

## Removal

`apk del luci-app-tunnel-ddns` first does "Switch everything off", then removes the files. The
uploaded sites in `/usr/share/www/` and `/etc/tunnel-ddns/sites/`, `/etc/acme/` and
`/etc/ssl/tunnel-ddns/` remain.

## HTTPS port

The site's port (also the LuCI port, there is one uhttpd) is changed in the **Web site**
section with the button next to **HTTPS port**. It applies at once and apart from
**Save & Apply**: the web server restarts on the new port, and if you are in LuCI through the
old port, reconnect with the link from the dialog (`https://<address>:<port>/cgi-bin/luci/`).
A separate button is needed because LuCI's normal apply confirmation reconnects on the old
port and would roll a port change back.

## Sites with their own build

Besides the public files, the archive may contain a `.tunnel-ddns/` directory with an
executable file `build` and whatever it needs. The package keeps this directory outside the
web root and runs `build` in it with these environment variables:

```
SITE_NAME    the name of the site
SITE_PUBLIC  the document root (/usr/share/www/<name>), where the pages are written
SITE_TMP     a scratch directory kept between runs (under /tmp, lost on reboot)
```

The build runs right after the upload, on the schedule and on the button. For such a site
the **Web site** section shows the **Rebuild schedule** field (a cron time, five fields; empty
means only on the button), the **Rebuild now** button and **Rebuild log**. The schedule
line lives in `/etc/crontabs/root`; the log of the last build in
`/tmp/tunnel-ddns/` (lost on a reboot), its result in `/etc/tunnel-ddns/state/`.

## Own login page

If the archive has `cgi-bin/login`, then while this site is on the router is entered only
through that page: a request to `/cgi-bin/luci/…` without a session gets the site's 404
page like any other missing address (only a JSON-RPC request from LuCI's own pages gets
the "login required" answer LuCI expects), the standard LuCI form is never shown, and the
direct JSON-RPC endpoint `/ubus` is switched off (LuCI falls back to its own RPC path
through `/cgi-bin/luci`, which sits behind the same check). After a login `/cgi-bin/luci/` opens; after a logout from LuCI
the site root. Switching the site off puts
everything back. The LuCI dispatcher in `/www/cgi-bin/luci` is not modified: a link to the
package's `luci-gate` is placed into the site's document root, and it lets a request through
to LuCI only with a valid session.

The page itself gets two ucode modules from the package:

```
import { create, verify } from 'tunnel-ddns.captcha';
let c = create({ language: 'en' });   // { id, png }: a base64 PNG (coloured letters and digits,
                                      // tilt, wave, noise); 'en' or 'ru'; null when too many
                                      // pictures are waiting for an answer
verify(c.id, text)                    // true when text is the answer; checked once; case and
                                      // Latin/Cyrillic look-alikes do not matter

import { login } from 'tunnel-ddns.login';
login({ username, password, client: REMOTE_ADDR, https: true })
  // { cookie }                     logged in: send Set-Cookie and redirect to LuCI
  // { error: 'throttled', wait }   after three failures from an address: a 30 s pause,
  //                                doubling up to 15 minutes
  // { error: 'denied' }            wrong user name or password
```

The picture is assembled on the router without image libraries (a bitmap font in
`/usr/share/tunnel-ddns/captcha-font.json`, the PNG is written by the module itself); the
answer is kept in `/tmp/tunnel-ddns/captcha/` for three minutes. The package neither checks
nor sets the root password: without one rpcd accepts any password, so set it in
**System → Administration**.
