# luci-app-tunnel-zerotier

The LuCI page **Tunnel → ZeroTier**: this router as a member of your ZeroTier networks. It
joins the networks you list, members of those networks reach the Internet, the router and
its LAN through it, and with an API token the networks of your ZeroTier Central account,
their members and routes are managed from the same page.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the entry appears in the **Tunnel** section.

## What it does

- **Node.** The `zerotier` package's service runs the node; its identity is kept in
  `/etc/config/zerotier` by that package. The overview shows the node ID, whether it is
  online and the version.
- **Networks this router joins.** A list of network IDs. On "Save & Apply" the router joins
  them (and leaves the ones removed). With an API token the router's node is authorized in
  each of them automatically; the **Authorize** button does the same by hand.
- **Access through the router.** A firewall zone for the ZeroTier interfaces: members reach
  the Internet through the router (and, with the **Access to the router and its LAN** box,
  the router itself and the networks behind it).
- **Networks of the account** (needs the API token): list, create and delete networks, a QR
  code with the network ID for the ZeroTier app, **Add to this router**.
- **Members** of a selected network: name, authorization, IP address, last seen, removal.
- **Routes** of a selected network, including **Exit through this router** (the route
  `0.0.0.0/0 via <this router's address in the network>`; each member also has to allow the
  default route in its ZeroTier app).

## Step by step

1. **Settings → API token**: a token from ZeroTier Central (Account → API Access Tokens).
2. **Networks this router joins → Add network…** with the network ID, or **Add to this
   router** next to a network of the account. Tick **Run ZeroTier**, **Save & Apply**.
3. A few seconds later the network's state shows "Member" with the router's address; if it
   shows "Waiting for authorization", click **Authorize** (or authorize the node in Central).
4. **Routes**: tick **Exit through this router** and **Save routes** for members to use the
   router as their way to the Internet; add the LAN subnet as a route (target
   `192.168.1.0/24`, via the router's address) for members to reach the LAN.
5. On the members' devices: join the network (the QR code helps on phones), then in Central
   or in the **Members** table authorize them.

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time with the default configuration.

- `/etc/config/zerotier`: `global.enabled` and one `network` section per listed network
  (`tunnel_zerotier_<id>`, with `allow_managed 1`, `allow_global 0`, `allow_default 0`,
  `allow_dns 0`). The example section `earth` shipped by the zerotier package is removed, so
  that the router does not join the public Earth network. The file gets mode 600 (it holds
  the node's identity secret). The zerotier service is enabled, restarted on changes, and
  stopped and disabled when ZeroTier is switched off here (only if it was switched on here:
  a zerotier service you run otherwise is left alone, marker `/etc/tunnel_zerotier/managed`).
- `/etc/config/firewall`: the zone `tunnel_zerotier` (devices `zt+`, input accepted or
  rejected by the access box) with forwarding to `wan`, and to and from `lan` with the
  access box; removed when ZeroTier is switched off.
- `/etc/config/tunnel_zerotier` gets mode 600 (it holds the API token).
- ZeroTier Central: on "Save & Apply" the router's node is authorized in every listed
  network through the API (member name = the router's hostname). Everything in the
  "Networks of the account", "Members" and "Routes" parts changes the account directly.

**Show log** in the overview displays the ZeroTier messages from the system log;
**Restart ZeroTier** restarts the service.

## Removal

`apk del luci-app-tunnel-zerotier` stops ZeroTier, removes the network sections and the
firewall zone, and removes the files. `/etc/config/tunnel_zerotier` and `/etc/config/zerotier`
(with the node identity) stay unless `apk` is told to drop configuration files.
