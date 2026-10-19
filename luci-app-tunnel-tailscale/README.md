# luci-app-tunnel-tailscale

The LuCI page **Tunnel → Tailscale**: this router as a device of your tailnet, offering
itself as an exit node and as the router of its LAN, so that the other devices of the
tailnet reach the Internet and the LAN through it.

Installing the package is described in the [main README](../README.md). Log in to LuCI again
after installing; the entry appears in the **Tunnel** section.

## What it does

- **Node.** The `tailscale` package's service runs the node; the login state is kept by that
  package in `/etc/tailscale/tailscaled.state` (and survives sysupgrades).
- **Login** with an auth key from the admin console on "Save & Apply", or with
  **Get login link** in the overview: a link (and QR code) to approve the router in a browser
  where you are logged in to Tailscale.
- **Settings** applied with `tailscale up`: device name, exit node, offered subnet routes
  (by default the router's LAN), accepting routes of other devices, the tailnet DNS,
  Tailscale SSH, shields up.
- **Access through the router.** A firewall zone for the `tailscale0` interface: devices of
  the tailnet reach the Internet through the router (and, with the **Access to the router
  and its LAN** box, the router itself and the networks behind it).
- **Overview**: connection state, the router's Tailscale address and name, whether the exit
  node and the routes are approved, the devices of the tailnet.

The devices themselves, their approval, the exit node and route approvals, key expiry and
the access rules of the tailnet are managed in the Tailscale admin console.

## Step by step

1. In the admin console (Settings → Keys) create an auth key (reusable, if the router may
   be reflashed) and enter it under **Settings → Auth key**; or skip it and use the login
   link later.
2. Check **Offer as exit node** and the routes, tick **Run Tailscale**, **Save & Apply**.
3. Without an auth key: **Get login link** in the overview, open it, approve the router.
4. In the admin console approve the exit node and the subnet route of the router; the
   overview shows "offered and approved".
5. On the devices: select the router as the exit node (and "allow LAN access" as needed).

## What the package changes on the router

Everything only on **Save & Apply**, nothing at install time with the default configuration.

- `/etc/config/tailscale` (the tailscale package's own settings): `fw_mode nftables`. The
  tailscale service is enabled and started while Tailscale is switched on here, and brought
  down (`tailscale down`), stopped and disabled when it is switched off (only if it was
  switched on here: a tailscale service you run otherwise is left alone, marker
  `/etc/tunnel-tailscale/managed`).
- The node's preferences through `tailscale up --reset …` with the settings of the page and
  `--netfilter-mode=off` (the firewall rules come from the zone below, not from tailscaled).
- `/etc/config/firewall`: the zone `tunnel-tailscale` (device `tailscale0`, input accepted or
  rejected by the access box) with forwarding to `wan`, and to and from `lan` with the
  access box; removed when Tailscale is switched off.
- `/etc/config/tunnel-tailscale` gets mode 600 (it holds the auth key).

**Show log** in the overview displays the Tailscale messages from the system log;
**Restart Tailscale** restarts the service and applies the settings again; **Log out**
removes the router from the tailnet (a new login is needed afterwards).

## Removal

`apk del luci-app-tunnel-tailscale` brings Tailscale down, stops the service, removes the
firewall zone and removes the files. `/etc/config/tunnel-tailscale` and the login state in
`/etc/tailscale/` stay unless `apk` is told to drop configuration files.
