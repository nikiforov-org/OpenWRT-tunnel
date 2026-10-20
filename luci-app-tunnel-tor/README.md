# luci-app-tunnel-tor

The LuCI page **Tunnel → Tor**: the router as a Tor onion service. The router gets an
address in the Tor network through which its own ports (SSH, the web interface or the site,
the Xray server) are reachable from anywhere, without a public IP address, open ports or a
domain. Only the profiles created on the page can use the address, each with its own key:
for everyone else the address does not exist.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the entry appears in the **Tunnel** section.

## What it does

- **An onion service** (version 3) on the router's own tor, with client authorization: the
  address is `<56 characters>.onion`, created on the first start and kept in
  `/etc/tor/tunnel-tor`. Every port in the **Ports** list leads to the same port on the
  router itself; the default list is 22 (SSH), 80 (the web interface or the site) and 443
  (the site over HTTPS, with the Xray server in front of it when it runs).
- **Bridges.** The router's tor connects to the Tor network by itself; where direct
  connections are blocked, it goes through bridges. **Built-in bridges** starts from the set
  of snowflake and obfs4 bridges shipped with the package
  (`/usr/share/tunnel-tor/bridges.txt`, Tor Browser's built-in list). With a
  **Country for bridges** set, the router refreshes that list once a day and on **Update
  bridges**: it asks `bridges.torproject.org` (the moat API, what Tor Browser's connection
  assist uses) for the bridges handed out in that country, through its own Tor connection
  (directly if tor is not connected), and merges them into the list, newest first, up to 12
  per transport. tor restarts with the new list only when the answer did not come through tor
itself: a tor that carried the request works and keeps its bridges until its next start. **Bridges entered below** takes the
  lines from bridges.torproject.org or the Telegram bot @GetBridgesBot; **No bridges** connects
  directly.
- **Profiles.** Any number of profiles, one x25519 key pair each, switchable on and off. The
  pair is generated on the router when a profile is added (or by **Generate** in the dialog);
  the router keeps the private key in `/etc/config/tunnel-tor` and installs the public
  key into the service. **Key** next to a profile shows what the client needs: the onion
  address, the private key for Tor Browser's prompt and the one-line `.auth_private` file for a
  tor daemon (Orbot, or a tor in front of an SSH or Xray client), plus a QR code of that line.
- **No firewall changes.** The router makes the connections itself; nothing is opened from
  WAN. The onion address works behind any NAT.

## Step by step

1. **Settings → Bridges**: leave **Built-in bridges** and enter the **Country for bridges**
   (two letters) so that the list stays current, or enter your own lines. Leave the **Ports**
   list as it is or add the ports you need.
2. **Profiles → Add profile…**, give it a name (the keys are filled in), **Save** in the
   dialog.
3. Tick **Run the onion service** and click **Save & Apply**. The overview shows the service
   connecting to the Tor network and then "connected"; the onion address appears right away,
   the service answers a minute or two after the connection is made.
4. **Key** next to a profile:
   - **Tor Browser**: open `http://<address>.onion/` (or `https://<address>.onion/` for
     443); when it asks for the key of the onion service, paste the private key.
   - **A tor daemon** (a computer, a server, Orbot): put the line shown into the file
     `<name>.auth_private` in the daemon's `ClientOnionAuthDir`, restart it, and connect
     through its SOCKS port: `ssh -o ProxyCommand='nc -x 127.0.0.1:9050 %h %p' root@<address>.onion`,
     or point an Xray client at `<address>.onion:443` through that proxy.

Switching a profile off (or deleting it) locks its key out at the next apply; the address
stays the same. A new key pair for a profile means the client has to get the new key.

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time with the default configuration.
On a reinstall or upgrade the package's init script is started by apk, so an existing
configuration is applied again right away.

- `/etc/tunnel-tor/torrc` (root:tor, mode 640): the tor configuration generated from
  `/etc/config/tunnel-tor` (which gets mode 600, it holds the private keys): the bridge
  lines, the onion service directory, its version and ports. It is added to the stock tor
  configuration through `tor.conf.tail_include` in `/etc/config/tor`, the way the tor package
  provides for. The file is replaced only after `tor --verify-config` accepts it together
  with the stock `/etc/tor/torrc`; any error, from an unreadable bridge line to a
  configuration rejected by tor, leaves the configuration in effect running and shows the
  reason in the overview. Only switching the service off removes it.
- `/etc/tor/tunnel-tor/` (tor:tor, mode 700): the service's keys and `hostname`, kept
  by tor; `authorized_clients/<name>.auth` for every enabled profile, written by the package
  from the profile's key. The directory stays when the service is switched off and when the
  package is removed; deleting it gives the service a new address.
- `/etc/tunnel-tor/bridges.txt` and `bridges.state`: the refreshed bridge list and the
  result of the last update (time, country, through Tor or directly, counts, error); while
  the service runs with the built-in list and a country, a line in `/etc/crontabs/root`
  (`# tunnel-tor-bridges`, once a day at a time chosen at random) runs
  `/usr/libexec/tunnel-tor/bridges-update`. The update needs `curl` (a dependency).
- The stock `tor` service is restarted on every change (tor re-reads `/etc/tor/torrc` on
  reload as the unprivileged tor user, which cannot read it, so a reload would stop it).
  The `tor` package enables and starts its service when it is installed; this package
  switches the service on with its configuration, and when the onion service is switched off
  it stops and disables the stock service only if it was off before this package switched it
  on (marker `/etc/tunnel-tor/managed`), otherwise it restarts it without this
  package's part. **Restart tor** in the overview restarts the service by hand.

The generated configuration and the list of authorized clients: **Show configuration** in the
overview; **Show log** shows the tor messages from the system log, including the bootstrap
progress.

## Removal

`apk del luci-app-tunnel-tor` removes the generated configuration and its inclusion
from `/etc/config/tor`, the cron line, and stops the stock tor service if this package had
switched it on.
`/etc/config/tunnel-tor` and the service's keys in `/etc/tor/tunnel-tor` stay.
