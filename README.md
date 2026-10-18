# OpenWRT-tunnel

LuCI packages for OpenWrt (package names start with `luci-app-tunnel_`). The packages are `noarch`, so
one `.apk` installs on a router of any architecture.

## Building

Docker is needed (OrbStack, for example). The script builds **unsigned** `.apk` packages for
OpenWrt 25.12 into `dist/` with the official OpenWrt SDK:

```sh
./build.sh            # 25.12.5 by default
./build.sh 25.12.5
```

Every package is a directory `luci-app-tunnel_<name>/` with a `Makefile` based on `luci.mk`. The last
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
ssh root@ROUTER 'cat > /tmp/luci-app-tunnel_ddns.apk' < dist/luci-app-tunnel_ddns-1.0.0-r2.apk
ssh root@ROUTER 'apk update'
ssh root@ROUTER 'apk add --allow-untrusted /tmp/luci-app-tunnel_ddns.apk'
```

The dependencies (`acme-acmesh`, `ddns-scripts`, …) come from the official feed, so the
router needs Internet on WAN. After installing, **log in to LuCI again** (the menu and the
permissions are cached per session): the packages appear in the **Tunnel** section of the top
menu.

Upgrading uses the same commands: `apk add` replaces the installed package in place even when
the version number has not changed (`Replacing luci-app-tunnel_ddns (1.0.0-r2 -> 1.0.0-r2)`) and runs
the package's postinst (LuCI cache reset, rpcd restart).

Removing: `apk del luci-app-tunnel_ddns`.

## Packages

| Package | LuCI menu | Purpose |
|---|---|---|
| [`luci-app-tunnel_ddns`](luci-app-tunnel_ddns/README.md) | Tunnel → Dynamic DNS | domains at several providers (dynamic DNS), Let's Encrypt certificates with automatic renewal, a web site served over HTTPS from the router; a site may have its own scheduled build and its own login page in place of the standard LuCI login. Setup: [luci-app-tunnel_ddns/README.md](luci-app-tunnel_ddns/README.md) |
