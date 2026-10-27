#!/bin/sh
# xtunnel-core/build.sh [ARCH…]: the package xtunnel-core for the OpenWrt package architectures given
# (default: x86_64 for the Docker stages, aarch64_cortex-a53, aarch64_generic and mips_24kc of the ZTE MF286R), into
# dist/ARCH/xtunnel-core-VERSION.apk (unsigned, packed with the apk of the OpenWrt SDK image as the SDK packs
# packages). It replaces the packages xray-core, obfs4proxy, snowflake-client and tor with libopenssl3 and
# libevent2:
#   /usr/bin/xray      one Go executable for xray and lyrebird (src/main.go; /usr/bin/lyrebird is a link
#                      to it), from the pinned upstream sources below: xray with the parts luci-app-xtunnel
#                      configures (src/xray/distro.go, trim.py) and a control socket for the balancer of
#                      the client's active link in place of the gRPC API (src/xray/control.go), lyrebird with
#                      obfs4, meek_lite and snowflake for tor, snowflake without its SQS rendezvous
#                      (src/snowflake)
#   /usr/sbin/tor      tor linked statically with LibreSSL (tor.sh, built with the toolchain of the SDK
#                      images), with the other files of OpenWrt's tor package of the same version (the init
#                      script, /etc/config/tor, /etc/tor/torrc, its user); the service is disabled: luci-app-xtunnel's
#                      sync enables and starts it while the onion service or the client's links through Tor need it
# Sources and the Go module cache stay in the Docker volumes xtunnel-src and xtunnel-gocache.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=1.0.0-r1
XRAY=v26.3.27                                    # as the xray-core package of OpenWrt 25.12
LYREBIRD=362a60bb4e3fa434130ef81a9990d83d6d8eaea5 # main after lyrebird-0.8.1: snowflake v2.14.1
SNOWFLAKE=v2.14.1
GO_IMAGE=golang:1.26-bookworm
SDK_IMAGE=openwrt/sdk:x86-64-25.12.6               # packing, and tor for x86_64
SDK_ARM=openwrt/sdk:mediatek-filogic-25.12.6        # tor for aarch64 (built for armv8-a, any aarch64 target)
SDK_MIPS=openwrt/sdk:ath79-nand-25.12.6             # tor for mips_24kc (MIPS32r2 big-endian without an FPU: the ZTE MF286R)
TOR_APK=tor-0.4.9.13-r1.apk                         # the files around /usr/sbin/tor, of the version tor.sh builds
FEED=https://downloads.openwrt.org/releases/25.12.6/packages
ARCHES=${*:-x86_64 aarch64_cortex-a53 aarch64_generic mips_24kc}
OUT=/tmp/xtunnel-core-build
NAME=xtunnel-core-build

goarch() { case $1 in x86_64) echo amd64 ;; aarch64_*) echo arm64 ;; mips_24kc) echo mips ;; *) echo "unsupported architecture $1" >&2; exit 1 ;; esac; }
GOARCHES=$(for a in $ARCHES; do goarch "$a"; done | sort -u | tr '\n' ' ')

rm -rf "$OUT" && mkdir -p "$OUT"
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d ${CPUS:+--cpus $CPUS} --name $NAME -v xtunnel-gocache:/go -v xtunnel-src:/src "$GO_IMAGE" sleep 3600 >/dev/null   # CPUS=1.5: fewer cores
[ -n "${KEEP:-}" ] || trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT      # KEEP=1: the build container stays
(cd "$ROOT/xtunnel-core/src" && tar -cf - --exclude '._*' .) | docker exec -i $NAME sh -c 'rm -rf /work && mkdir -p /work/src && tar -xf - -C /work/src'
docker exec -i $NAME sh -c 'cat > /work/trim.py' < "$ROOT/xtunnel-core/trim.py"

docker exec -i -e XRAY=$XRAY -e LYREBIRD=$LYREBIRD -e SNOWFLAKE=$SNOWFLAKE -e GOARCHES="$GOARCHES" $NAME bash -s <<'EOS'
set -euo pipefail
fetch() {   # fetch DIR URL REF (a tag or a commit)
	[ -d "$1/.git" ] && git -C "$1" rev-parse -q --verify "$3^{commit}" >/dev/null && return 0
	rm -rf "$1"; git init -q "$1"
	if git -C "$1" fetch -q --depth 1 "$2" "$3"; then
		case $3 in v*) git -C "$1" tag -f "$3" FETCH_HEAD >/dev/null ;; esac
	else
		rm -rf "$1"; git clone -q "$2" "$1"
	fi
	git -C "$1" rev-parse -q --verify "$3^{commit}" >/dev/null
}
fetch /src/xray https://github.com/XTLS/Xray-core.git $XRAY
fetch /src/lyrebird https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird.git $LYREBIRD
fetch /src/snowflake https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake.git $SNOWFLAKE
W=/work
rm -rf $W/xray-src $W/lyrebird-src $W/snowflake-src $W/core
git -C /src/xray archive --prefix=xray-src/ $XRAY | tar -x -C $W
git -C /src/lyrebird archive --prefix=lyrebird-src/ $LYREBIRD | tar -x -C $W
git -C /src/snowflake archive --prefix=snowflake-src/ $SNOWFLAKE | tar -x -C $W

# xray: only the parts of the JSON configuration that the package writes (trim.py)
python3 /work/trim.py $W/xray-src
# snowflake without the SQS rendezvous
cp $W/src/snowflake/rendezvous_sqs.go $W/snowflake-src/client/lib/rendezvous_sqs.go

# the executable: our files, xray's and lyrebird's main packages as packages of it
C=$W/core
mkdir -p $C/xray $C/lyrebird
cp $W/src/main.go $C/
cp $W/src/xray/distro.go $W/src/xray/control.go $C/xray/
# run.go: the control socket once the instance runs (control.go)
for f in main.go run.go version.go; do sed 's/^package main$/package xray/; s/^func main() {$/func Main() {/; /main\/distro\/all"$/d; s/^\tdefer server.Close()$/&\n\tlistenControl(server)/' $W/xray-src/main/$f > $C/xray/$f; done
grep -q 'listenControl(server)' $C/xray/run.go
for f in x25519.go curve25519.go; do sed 's/^package all$/package xray/' $W/xray-src/main/commands/all/$f > $C/xray/$f; done
for f in $(cd $W/lyrebird-src/cmd/lyrebird && ls *.go | grep -v _test.go); do
	sed 's/^package main$/package lyrebird/; s/^func main() {$/func Main() {/' $W/lyrebird-src/cmd/lyrebird/$f > $C/lyrebird/$f
done
# the module path has the length of github.com/xtls/xray-core, which xray's errors cut off the name of the
# function that made them: the errors of run.go then start with "xray:" (the package of src/xray)
cat > $C/go.mod <<EOF
module xtunnel.local/xtunnelcore

go 1.26

require (
	github.com/xtls/xray-core v0.0.0
	gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird v0.0.0
	gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake/v2 v2.0.0
)

replace github.com/xtls/xray-core => ../xray-src

replace gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird => ../lyrebird-src

replace gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake/v2 => ../snowflake-src
EOF
grep '^replace' $W/lyrebird-src/go.mod | grep -v snowflake >> $C/go.mod || true
cd $C
go mod tidy
# the imports trim.py left unused, as go build reports them
for i in 1 2 3 4 5 6; do
	go build -tags grpcnotrace ./... 2> $W/unused.log && break
	python3 - $W/unused.log <<'EOF'
import re, sys
drop = {}
for l in open(sys.argv[1]):
	m = re.match(r'^(\S+\.go):(\d+):\d+: .* imported (as \w+ )?and not used', l)
	if m: drop.setdefault(m.group(1), set()).add(int(m.group(2)))
if not drop:
	sys.stderr.write(open(sys.argv[1]).read()); sys.exit(1)
for f, lines in drop.items():
	src = open(f).read().split('\n')
	open(f, 'w').write('\n'.join(l for n, l in enumerate(src, 1) if n not in lines))
EOF
done
# GOMIPS=softfloat for mips (the 24Kc has no FPU); the other architectures ignore it
for a in $GOARCHES; do
	CGO_ENABLED=0 GOOS=linux GOARCH=$a GOMIPS=softfloat go build -tags grpcnotrace -trimpath -ldflags "-s -w -buildid=" -o $W/out/$a/xray .
	echo "built $a: $(stat -c %s $W/out/$a/xray) bytes"
done
EOS

for a in $GOARCHES; do mkdir -p "$OUT/$a" && docker cp "$NAME:/work/out/$a/xray" "$OUT/$a/xray" >/dev/null; done

# tor, once for each Go architecture, in the SDK image of it (the SDK's user writes to OUT); kept in
# /tmp/xtunnel-core-tor by tor.sh and the image, so that a change of the Go part does not build it again
chmod 777 "$OUT"
for g in $GOARCHES; do
	case $g in amd64) img=$SDK_IMAGE ;; arm64) img=$SDK_ARM ;; mips) img=$SDK_MIPS ;; esac
	cache=/tmp/xtunnel-core-tor/$( (echo "$img"; cat "$ROOT/xtunnel-core/tor.sh") | shasum -a 256 | cut -c1-16)-$g
	if [ ! -s "$cache/tor" ]; then
		docker run --rm -v "$ROOT/xtunnel-core/tor.sh:/tor.sh:ro" -v "$OUT:/out" "$img" sh /tor.sh /out/tor-$g
		mkdir -p "$cache" && cp "$OUT/tor-$g/tor" "$cache/tor"
	fi
	mkdir -p "$OUT/tor-$g" && cp "$cache/tor" "$OUT/tor-$g/tor"
done

# the packages: the files of OpenWrt's tor package with this tor, and the Go executable
for a in $ARCHES; do
	g=$(goarch "$a"); d="$OUT/pkg-$a"
	mkdir -p "$d/usr/bin"
	curl -fsS -o "$OUT/tor-$a.apk" "$FEED/$a/packages/$TOR_APK"
	cp "$OUT/$g/xray" "$d/usr/bin/xray"; chmod 755 "$d/usr/bin/xray"
	ln -sf xray "$d/usr/bin/lyrebird"
done
# as root in the container, in its own file system (owners and modes as packed)
docker run --rm --user 0:0 -v "$OUT:/out" "$SDK_IMAGE" sh -c '
	set -e
	APK=$PWD/staging_dir/host/bin/apk
	for o in /out/pkg-*; do
		a=${o#/out/pkg-}
		case $a in x86_64) g=amd64 ;; mips_24kc) g=mips ;; *) g=arm64 ;; esac
		d=/tmp/pkg-$a; rm -rf $d; cp -a $o $d
		$APK extract --allow-untrusted --no-chown --destination $d /out/tor-$a.apk
		cp /out/tor-$g/tor $d/usr/sbin/tor; chmod 755 $d/usr/sbin/tor
		P=$d/lib/apk/packages
		for f in rusers conffiles conffiles_static; do mv $P/tor.$f $P/xtunnel-core.$f; done
		rm -f $P/tor.list
		(cd $d && find . -type f,l -printf "/%P\n" | sort) > /tmp/list && mv /tmp/list $P/xtunnel-core.list
		for t in post-install post-upgrade pre-deinstall; do
			{
				echo "#!/bin/sh"
				[ $t = post-upgrade ] && echo "export PKG_UPGRADE=1"
				[ $t = pre-deinstall ] || echo "[ \"\${IPKG_NO_SCRIPT}\" = \"1\" ] && exit 0"
				echo "[ -s \${IPKG_INSTROOT}/lib/functions.sh ] || exit 0"
				echo ". \${IPKG_INSTROOT}/lib/functions.sh"
				echo "export root=\"\${IPKG_INSTROOT}\""
				echo "export pkgname=\"xtunnel-core\""
				if [ $t = pre-deinstall ]; then echo default_prerm; else echo add_group_and_user; echo default_postinst; fi
				# the tor service runs only while luci-app-xtunnel needs it (its sync enables and starts it, stops
				# and disables it otherwise): disabled in the image and at a fresh install (default_postinst enables
				# and starts it); at an upgrade the new executable is started again only if the service is enabled
				[ $t = post-install ] && echo "[ -n \"\$root\" ] || /etc/init.d/tor stop >/dev/null 2>&1; \$root/etc/init.d/tor disable >/dev/null 2>&1"
				[ $t = post-upgrade ] && echo "[ -n \"\$root\" ] || { if /etc/init.d/tor enabled >/dev/null 2>&1; then /etc/init.d/tor restart; else /etc/init.d/tor stop; fi >/dev/null 2>&1; }"
				echo "exit 0"
			} > /tmp/$t
		done
		mkdir -p /out/apk/$a
		chown -R 0:0 $d
		find $d -type d -exec chmod 755 {} +
		sh -c "$APK mkpkg \
			--info \"name:xtunnel-core\" --info \"version:'"$VERSION"'\" \
			--info \"description:xray and lyrebird (obfs4, meek_lite and snowflake) in one executable, /usr/bin/xray and /usr/bin/lyrebird, and tor linked with LibreSSL, /usr/sbin/tor, with the tor service of OpenWrt\" \
			--info \"arch:$a\" --info \"license:MPL-2.0 BSD-3-Clause BSD-2-Clause ISC OpenSSL\" \
			--info \"origin:xtunnel-core\" --info \"url:https://github.com/nikiforov-org/OpenWRT-tunnel\" \
			--info \"maintainer:Evgenii Nikiforov\" \
			--info \"replaces:xray-core obfs4proxy snowflake-client tor tor-basic\" \
			--info \"depends:ca-bundle libgcc1\" \
			--script post-install:/tmp/post-install --script post-upgrade:/tmp/post-upgrade --script pre-deinstall:/tmp/pre-deinstall \
			--files $d --output /out/apk/$a/xtunnel-core-'"$VERSION"'.apk"
	done'
for a in $ARCHES; do
	mkdir -p "$ROOT/dist/$a"
	rm -f "$ROOT/dist/$a"/xtunnel-core-*.apk
	cp -X "$OUT/apk/$a/xtunnel-core-$VERSION.apk" "$ROOT/dist/$a/"
	ls -l "$ROOT/dist/$a/xtunnel-core-$VERSION.apk"
done
