# OpenWRT-tunnel

LuCI packages for OpenWrt (package names start with `luci-app-tunnel-`). The packages are `noarch`, so
one `.apk` installs on a router of any architecture.

## Building

Docker is needed (OrbStack, for example). The script builds **unsigned** `.apk` packages for
OpenWrt 25.12 into `dist/` with the official OpenWrt SDK:

```sh
./build.sh            # 25.12.6 by default
./build.sh 25.12.6
```

Every package is a directory `luci-app-tunnel-<name>/` with a `Makefile` based on `luci.mk`. The last
line of the Makefile must be `# call BuildPackage - OpenWrt buildroot signature`: the SDK's
feed scanner selects Makefiles by this text, and without it the package is left out of the
build (`No feed for package ... found`).

## Installing on the router

OpenWrt 25.12 (the `apk` package manager). The packages are unsigned, so they are installed
with `--allow-untrusted` (the signature check is skipped). No public key has to be put on
the router.

The file is copied over `ssh`: OpenWrt runs dropbear without an sftp server, and a modern
`scp` (OpenSSH 9+) uses sftp by default and fails with
`/usr/libexec/sftp-server: not found`. `ssh 'cat > file' < file` works everywhere (the
alternative is `scp -O`, the old protocol).

```sh
# ROUTER is the router's address, e.g. 192.168.1.1
ssh root@ROUTER 'cat > /tmp/luci-app-tunnel-ddns.apk' < dist/luci-app-tunnel-ddns-1.0.0-r1.apk
ssh root@ROUTER 'apk update'
ssh root@ROUTER 'apk add --allow-untrusted /tmp/luci-app-tunnel-ddns.apk'
```

The dependencies (`acme-acmesh`, `ddns-scripts`, …) come from the official feed, so the
router needs Internet on WAN. After installing, **log in to LuCI again** (the menu and the
permissions are cached per session): the packages appear in the **Tunnel** section of the top
menu.

Upgrading uses the same commands: `apk add` replaces the installed package in place even when
the version number has not changed (`Replacing luci-app-tunnel-ddns (1.0.0-r1 -> 1.0.0-r1)`) and runs
the package's postinst (LuCI cache reset, rpcd restart).

Removing: `apk del luci-app-tunnel-ddns`.

## Packages

| Package | LuCI menu | Purpose |
|---|---|---|
| [`luci-app-tunnel-ddns`](luci-app-tunnel-ddns/README.md) | Tunnel → Dynamic DNS | domains at several providers (dynamic DNS), Let's Encrypt certificates with automatic renewal, a web site served over HTTPS from the router; a site may have its own scheduled build and its own login page in place of the standard LuCI login. Setup: [luci-app-tunnel-ddns/README.md](luci-app-tunnel-ddns/README.md) |
| [`luci-app-tunnel-server`](luci-app-tunnel-server/README.md) | Tunnel → Server | one xray process with up to three transports: VLESS + REALITY over TCP with XTLS-Vision, VLESS + REALITY over XHTTP, and Hysteria2 over QUIC with the certificate of a domain from the Dynamic DNS page; profiles (a UUID and a Hysteria2 password each) with one link and QR code per transport, keys generated on the router, firewall rules while it runs. Setup: [luci-app-tunnel-server/README.md](luci-app-tunnel-server/README.md) |
| [`luci-app-tunnel-client`](luci-app-tunnel-client/README.md) | Tunnel → Client | the LAN reaches the Internet through tunnel clients: profiles with up to three links of a server (TCP + XTLS-Vision, XHTTP, Hysteria2), all in one xray process; the LAN is handed to it with TPROXY; one active link, by hand or by measured speed, split tunnelling by a list of domains, subnets and daily-fetched sources, DNS split the same way, a kill switch (no way around the client), IPv6 off for the LAN. Setup: [luci-app-tunnel-client/README.md](luci-app-tunnel-client/README.md) |
| [`luci-app-tunnel-zerotier`](luci-app-tunnel-zerotier/README.md) | Tunnel → ZeroTier | this router as a member and exit of your ZeroTier networks; with a Central API token the networks of the account, their members and routes are managed on the page; firewall zone for the ZeroTier interfaces. Setup: [luci-app-tunnel-zerotier/README.md](luci-app-tunnel-zerotier/README.md) |
| [`luci-app-tunnel-tailscale`](luci-app-tunnel-tailscale/README.md) | Tunnel → Tailscale | this router as an exit node and subnet router of your tailnet; login with an auth key or a login link, settings applied through tailscale up, firewall zone for tailscale0. Setup: [luci-app-tunnel-tailscale/README.md](luci-app-tunnel-tailscale/README.md) |
| [`luci-app-tunnel-tor`](luci-app-tunnel-tor/README.md) | Tunnel → Tor | the router as a Tor onion service with client authorization: its own ports (SSH, the web interface, the Xray server) reachable through an .onion address from anywhere, without a public IP address or open ports; profiles with keys generated on the router, built-in or own bridges. Setup: [luci-app-tunnel-tor/README.md](luci-app-tunnel-tor/README.md) |
