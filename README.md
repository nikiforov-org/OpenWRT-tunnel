# OpenWRT-tunnel

LuCI packages for OpenWrt. **`luci-app-xtunnel`** is the one to install: dynamic DNS with Let's Encrypt
certificates and a web site, an xray server with a Tor onion service, and the LAN through tunnel clients,
in the **XTunnel** section of the LuCI menu. The earlier packages `luci-app-tunnel-ddns`, `-server`,
`-client` and `-tor` it replaces stay in the repository; they are not installed together with it. The
packages are `noarch`, so one `.apk` installs on a router of any architecture.

## Building

Docker is needed (OrbStack, for example). The script builds **unsigned** `.apk` packages for
OpenWrt 25.12 into `dist/` with the official OpenWrt SDK:

```sh
./utils/build.sh            # 25.12.6 by default
./utils/build.sh 25.12.6
```

Every package is a directory (`luci-app-xtunnel/`, `luci-app-tunnel-<name>/`) with a `Makefile` based on `luci.mk`. The last
line of the Makefile must be `# call BuildPackage - OpenWrt buildroot signature`: the SDK's
feed scanner selects Makefiles by this text, and without it the package is left out of the
build (`No feed for package ... found`).

## Firmware with the packages

`utils/firmware.sh` makes an OpenWrt image for one device with the packages of the release's own
image (LuCI included) and `luci-app-xtunnel` from `dist/`, using
the official Image Builder (Docker image `openwrt/imagebuilder`). PROFILE is the device's profile
name in the release, as on firmware-selector.openwrt.org:

```sh
./utils/build.sh
./utils/firmware.sh PROFILE             # 25.12.6 by default
./utils/firmware.sh PROFILE 25.12.6
```

The images, their package list (`.manifest`) and `sha256sums` go to `firmware/PROFILE/`. The
sysupgrade image is written over an installed OpenWrt (System → Backup / Flash Firmware, or
`sysupgrade -n` to drop the settings); the packages start with everything off, as after `apk add`.

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
ssh root@ROUTER 'cat > /tmp/luci-app-xtunnel.apk' < dist/luci-app-xtunnel-1.0.0-r1.apk
ssh root@ROUTER 'apk update'
ssh root@ROUTER 'apk add --allow-untrusted /tmp/luci-app-xtunnel.apk'
```

The dependencies (xray-core, tor, uacme, …) come from the official feed, so the router needs
Internet on WAN. After installing, **log in to LuCI again** (the menu and the permissions are
cached per session): the pages appear in the **XTunnel** section of the top menu.

Upgrading uses the same commands: `apk add` replaces the installed package in place even when
the version number has not changed (`Replacing luci-app-xtunnel (1.0.0-r1 -> 1.0.0-r1)`) and runs
the package's postinst (LuCI cache reset, rpcd restart).

Removing: `apk del luci-app-xtunnel`.

## Packages

| Package | LuCI menu | Purpose |
|---|---|---|
| [`luci-app-xtunnel`](luci-app-xtunnel/README.md) | XTunnel → Dynamic DNS, Server, Client | everything below in one package without duplicated parts: one xray process for the server and the client, one tor for the onion service and the client's links through Tor (its settings and the onion service are sections of the Server page; a server profile holds the UUID, the Hysteria2 password and the Tor key, and **Links** gives the links, the links through Tor and the Tor key). Setup: [luci-app-xtunnel/README.md](luci-app-xtunnel/README.md) |
| [`luci-app-tunnel-ddns`](luci-app-tunnel-ddns/README.md) | Tunnel → Dynamic DNS | domains at several providers (dynamic DNS), Let's Encrypt certificates with automatic renewal, a web site served over HTTPS from the router; a site may have its own scheduled build and its own login page in place of the standard LuCI login. Setup: [luci-app-tunnel-ddns/README.md](luci-app-tunnel-ddns/README.md) |
| [`luci-app-tunnel-server`](luci-app-tunnel-server/README.md) | Tunnel → Server | one xray process (the same one as the client's when both are installed) with up to three transports: VLESS + REALITY over TCP with XTLS-Vision, VLESS + REALITY over XHTTP, and Hysteria2 over QUIC with the certificate of a domain from the Dynamic DNS page; profiles (a UUID and a Hysteria2 password each) with one link and QR code per transport (and the VLESS ones through the onion address of `luci-app-tunnel-tor`), keys generated on the router, firewall rules while it runs. Setup: [luci-app-tunnel-server/README.md](luci-app-tunnel-server/README.md) |
| [`luci-app-tunnel-client`](luci-app-tunnel-client/README.md) | Tunnel → Client | the LAN reaches the Internet through tunnel clients: profiles with the links of a server (TCP + XTLS-Vision, XHTTP, Hysteria2, and TCP + XTLS-Vision and XHTTP through Tor to its onion address with the key of its onion service), all in one xray process (the same one as the server's when both are installed); the LAN is handed to it with TPROXY; one active link, by hand or by measured speed, split tunnelling by a list of domains, subnets and daily-fetched sources, DNS split the same way, a kill switch (no way around the client), IPv6 off for the LAN. Setup: [luci-app-tunnel-client/README.md](luci-app-tunnel-client/README.md) |
| [`luci-app-tunnel-tor`](luci-app-tunnel-tor/README.md) | Tunnel → Tor | the router as a Tor onion service with client authorization: its own ports (SSH, the web interface, the Xray server) reachable through an .onion address from anywhere, without a public IP address or open ports; profiles with keys generated on the router, built-in or own bridges. Setup: [luci-app-tunnel-tor/README.md](luci-app-tunnel-tor/README.md) |

The rows after the first are the earlier packages that `luci-app-xtunnel` replaces.
