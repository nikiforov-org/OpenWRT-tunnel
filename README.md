# OpenWRT-tunnel

LuCI packages for OpenWrt. **`luci-app-xtunnel`** is the one to install: dynamic DNS with Let's Encrypt
certificates and a web site, an xray server, the LAN through tunnel clients, and the reverse access
between routers running the package (a router without a public address administered through the link
it keeps to another one), in the **XTunnel** section of the LuCI menu. The earlier packages
`luci-app-tunnel-ddns`, `-server`, `-client` and `-tor` it replaces stay in the repository; they are not
installed together with it. The LuCI packages are `noarch`, so one `.apk` installs on a router of any
architecture; their executable (xray) comes in [`xtunnel-core`](#xtunnel-core), one package per
architecture.

## Building

Docker is needed (OrbStack, for example). The script builds **unsigned** `.apk` packages for
OpenWrt 25.12 into `dist/` with the official OpenWrt SDK:

```sh
./utils/build.sh            # 25.12.6 by default
./utils/build.sh 25.12.6
./xtunnel-core/build.sh     # xtunnel-core into dist/ARCH/ (x86_64, aarch64_cortex-a53, aarch64_generic, mips_24kc)
./zte-mf286r/build.sh       # the ZTE MF286R's own packages into dist/zte-mf286r/ (the SDK of ath79/nand)
```

Every package is a directory (`luci-app-xtunnel/`, `luci-app-tunnel-<name>/`) with a `Makefile` based on `luci.mk`. The last
line of the Makefile must be `# call BuildPackage - OpenWrt buildroot signature`: the SDK's
feed scanner selects Makefiles by this text, and without it the package is left out of the
build (`No feed for package ... found`). The directories of `zte-mf286r/` are the packages of the ZTE MF286R's
firmware (see the next section).

## Firmware with the packages

`utils/firmware.sh` makes an OpenWrt image for one device with the packages of the release's own
image (LuCI included; without the attended sysupgrade and PPP, which these routers do not use) and
`luci-app-xtunnel` with `xtunnel-core` from `dist/`, using the official Image Builder (Docker image
`openwrt/imagebuilder`). PROFILE is the device's profile name in the release, as on
firmware-selector.openwrt.org:

```sh
./utils/build.sh
./xtunnel-core/build.sh                 # once, and after a change of xtunnel-core
./utils/firmware.sh PROFILE             # 25.12.6 by default
./utils/firmware.sh PROFILE 25.12.6
```

The images, their package list (`.manifest`) and `sha256sums` go to `firmware/PROFILE/`. The
sysupgrade image is written over an installed OpenWrt (System → Backup / Flash Firmware, or
`sysupgrade -n` to drop the settings); the packages start with everything off, as after `apk add`.

A device with packages of its own has a directory named after its profile with hyphens. `zte-mf286r/` holds the
ZTE MF286R's: `mf286r-modem` (the internal LTE module as the interface `wwan`: the `ncm` protocol over AT on
`/dev/ttyACM0` with the data on the module's RNDIS interface, the socket printed WAN/LAN1 as the interface `wan`,
a lock for the one AT port that netifd and the pages share, `modem-info`), `luci-app-ic` (Status → Cellular
Network: the module's status), `luci-app-sms` (Services → SMS: messages and USSD through `sms_tool`), `mf286r-usb`
(Services → USB: the Storage page for the drives on the socket of the case, with the Printer, Shares and Media
pages of p910nd, ksmbd and minidlna under it) and `kmod-fs-apfs` (APFS, read and write, the out-of-tree module
linux-apfs-rw built against the release's kernel). `zte-mf286r/build.sh` builds them with the SDK of ath79/nand
into `dist/zte-mf286r/`; `zte-mf286r/packages` lists the packages of the release for the image (the module's
drivers and `sms-tool`, the file systems and tools of the drives, `ksmbd-server` with avahi and wsdd2, `minidlna`,
`p910nd`, `luci-app-commands`, `dnsmasq-full`, `zram-swap` with `kmod-zram`: a compressed swap in RAM for the
120 MB of the box, sized by `system.@system[0].zram_size_mb`):

```sh
./zte-mf286r/build.sh
./xtunnel-core/build.sh mips_24kc
./utils/firmware.sh zte_mf286r
```

## Installing on the router

OpenWrt 25.12 (the `apk` package manager). The packages are unsigned, so they are installed
with `--allow-untrusted` (the signature check is skipped). No public key has to be put on
the router.

The file is copied over `ssh`: OpenWrt runs dropbear without an sftp server, and a modern
`scp` (OpenSSH 9+) uses sftp by default and fails with
`/usr/libexec/sftp-server: not found`. `ssh 'cat > file' < file` works everywhere (the
alternative is `scp -O`, the old protocol).

```sh
# ROUTER is the router's address, e.g. 192.168.1.1; ARCH its package architecture
# (aarch64_cortex-a53, aarch64_generic, mips_24kc, x86_64: DISTRIB_ARCH in /etc/openwrt_release)
ssh root@ROUTER 'cat > /tmp/luci-app-xtunnel.apk' < dist/luci-app-xtunnel-1.0.0-r1.apk
ssh root@ROUTER 'cat > /tmp/xtunnel-core.apk' < dist/ARCH/xtunnel-core-1.0.0-r1.apk
ssh root@ROUTER 'apk update'
ssh root@ROUTER 'apk add --allow-untrusted /tmp/luci-app-xtunnel.apk /tmp/xtunnel-core.apk'
```

`xtunnel-core` holds xray (see [xtunnel-core](#xtunnel-core)); the other dependencies (uacme, curl, …)
come from the official feed,
so the router needs Internet on WAN. After installing, **log in to LuCI again** (the menu and the permissions are
cached per session): the pages appear in the **XTunnel** section of the top menu.

Upgrading uses the same commands: `apk add` replaces the installed package in place even when
the version number has not changed (`Replacing luci-app-xtunnel (1.0.0-r1 -> 1.0.0-r1)`) and runs
the package's postinst (LuCI cache reset, rpcd restart, and a running xray is restarted when its
executable or its settings changed: the LAN's connections through the client reconnect).

Removing: `apk del luci-app-xtunnel xtunnel-core`.

## Packages

| Package | LuCI menu | Purpose |
|---|---|---|
| [`luci-app-xtunnel`](luci-app-xtunnel/README.md) | XTunnel → Dynamic DNS, Server, Client | everything below in one package without duplicated parts: one xray process for the server and the client; the reverse access between routers running the package (a server profile with "Reverse access" and local ports that lead to the SSH and web interface of the profile's router through the channel its client keeps; a client profile with "Reverse access" and local ports to the server's router), and the client without the LAN ("LAN through the client" off). Setup: [luci-app-xtunnel/README.md](luci-app-xtunnel/README.md) |
| [`luci-app-tunnel-ddns`](luci-app-tunnel-ddns/README.md) | Tunnel → Dynamic DNS | domains at several providers (dynamic DNS), Let's Encrypt certificates with automatic renewal, a web site served over HTTPS from the router; a site may have its own scheduled build and its own login page in place of the standard LuCI login. Setup: [luci-app-tunnel-ddns/README.md](luci-app-tunnel-ddns/README.md) |
| [`luci-app-tunnel-server`](luci-app-tunnel-server/README.md) | Tunnel → Server | one xray process (the same one as the client's when both are installed) with up to three transports: VLESS + REALITY over TCP with XTLS-Vision, VLESS + REALITY over XHTTP, and Hysteria2 over QUIC with the certificate of a domain from the Dynamic DNS page; profiles (a UUID and a Hysteria2 password each) with one link and QR code per transport (and the VLESS ones through the onion address of `luci-app-tunnel-tor`), keys generated on the router, firewall rules while it runs. Setup: [luci-app-tunnel-server/README.md](luci-app-tunnel-server/README.md) |
| [`luci-app-tunnel-client`](luci-app-tunnel-client/README.md) | Tunnel → Client | the LAN reaches the Internet through tunnel clients: profiles with the links of a server (TCP + XTLS-Vision, XHTTP, Hysteria2, and TCP + XTLS-Vision and XHTTP through Tor to its onion address with the key of its onion service), all in one xray process (the same one as the server's when both are installed); the LAN is handed to it with TPROXY; one active link, by hand or by measured speed, split tunnelling by a list of domains, subnets and daily-fetched sources, DNS split the same way, a kill switch (no way around the client), IPv6 off for the LAN. Setup: [luci-app-tunnel-client/README.md](luci-app-tunnel-client/README.md) |
| [`luci-app-tunnel-tor`](luci-app-tunnel-tor/README.md) | Tunnel → Tor | the router as a Tor onion service with client authorization: its own ports (SSH, the web interface, the Xray server) reachable through an .onion address from anywhere, without a public IP address or open ports; profiles with keys generated on the router, built-in or own bridges. Setup: [luci-app-tunnel-tor/README.md](luci-app-tunnel-tor/README.md) |

The rows after the first are the earlier packages that `luci-app-xtunnel` replaces.

### xtunnel-core

`luci-app-xtunnel` depends on `xtunnel-core`, built from the pinned upstream source by `xtunnel-core/build.sh`
(Go in Docker, packed with the apk of the OpenWrt SDK image) into `dist/ARCH/xtunnel-core-VERSION.apk` for
`x86_64`, `aarch64_cortex-a53`, `aarch64_generic` and `mips_24kc` (MIPS32r2 big-endian without an FPU, the ZTE
MF286R: `GOMIPS=softfloat`). It replaces the package `xray-core`:

- `/usr/bin/xray`: xray (Xray-core v26.3.27, the version of the `xray-core` package of OpenWrt 25.12) with
  only the parts the package configures (VLESS with REALITY or TLS over TCP and XHTTP, Hysteria2 with
  Salamander, dokodemo-door, SOCKS, freedom, blackhole, DNS, the reverse proxy; the commands `run`,
  `version`, `x25519` and `control`). In place of xray's gRPC API (not built in), `xray run` listens on a
  Unix socket (root only) for the override of the balancer of the client's active link, which
  `xray control bo|bi` sets and reads. The executable is 19 MB for aarch64 and 22 MB for mips_24kc, the
  apk 7 MB.

Earlier versions of the package also carried tor and the pluggable transports (lyrebird, snowflake) for a Tor
onion service and links through Tor; an upgrade stops that tor and removes its configuration, the keys of the
onion service in `/etc/tor/xtunnel-tor/` stay.
