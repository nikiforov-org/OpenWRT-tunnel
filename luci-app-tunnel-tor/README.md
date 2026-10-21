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
  itself: a tor that carried the request works and keeps its bridges until its next start.
  **Bridges entered below** takes the lines from bridges.torproject.org or the Telegram bot
  @GetBridgesBot; **No bridges** connects directly.
- **Snowflake bridges** (built-in or entered lines): **Only when no other bridge works** (the
  default), **Always** or **Never**. Snowflake reaches the Tor network through volunteer
  proxies found by a broker and keeps trying new proxies, which costs traffic. In the default
  mode the configuration holds only the other bridges; every 2 minutes
  `/usr/libexec/tunnel-tor/watch` asks tor through its control port (127.0.0.1, cookie
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
  `/etc/tor/tunnel-tor-data`, so that tor does not download the directory again after a
  restart of the router (about 17 MB each time); tor rewrites the consensus there every few
  hours (about 3 MB). **Less padding traffic** sets tor's `ReducedConnectionPadding` and
  `ReducedCircuitPadding`: idle connections to relays are closed sooner, less padding is sent
  on the connections and only the circuit padding machines with a low overhead are used (the
  tor manual offers these options for clients on links where traffic is expensive).
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
  lines, the onion service directory, its version and ports, the traffic options, and a
  control port on 127.0.0.1 (`ControlPort auto`, the port written to `control.port` in the
  data directory, `CookieAuthentication 1`) for the watch script and the overview, which asks
  tor there for its bootstrap progress. It is added to the stock tor
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
- With snowflake as the fallback and a list of snowflake and other lines, a line in
  `/etc/crontabs/root` (`# tunnel-tor-watch`, every 2 minutes) runs
  `/usr/libexec/tunnel-tor/watch`; its last result is in `/tmp/tunnel-tor/watch.json`, and
  `/etc/tunnel-tor/snowflake.on` (the time it was written) exists while the snowflake lines are
  added.
- `/etc/hotplug.d/iface/90-tunnel-tor`: on ifup, ifdown and ifupdate of an interface of the wan
  zone, 3 seconds later, `watch reconnect` (one at a time); the route in effect is kept in
  `/tmp/tunnel-tor/uplink`, and tor is reconnected only when it changed.
- `/etc/tor/tunnel-tor-data/` (tor:tor, mode 700) while the cache is kept on the router's
  storage. When the option is switched on or off, the cache files (`cached-*`, `state`) are
  copied to the other directory before tor restarts, so that tor does not download the
  directory again; afterwards only one copy is kept (the files in `/var/lib/tor` are removed
  while tor runs from the storage, the directory on the storage when the option is off).
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
from `/etc/config/tor`, the cron lines, the cache in `/etc/tor/tunnel-tor-data`, and stops the
stock tor service if this package had switched it on.
`/etc/config/tunnel-tor` and the service's keys in `/etc/tor/tunnel-tor` stay.
