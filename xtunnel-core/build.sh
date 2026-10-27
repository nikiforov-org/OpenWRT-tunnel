#!/bin/sh
# xtunnel-core/build.sh [ARCH…]: the package xtunnel-core for the OpenWrt package architectures given
# (default: x86_64 for the Docker stages, aarch64_cortex-a53, aarch64_generic and mips_24kc of the ZTE MF286R), into
# dist/ARCH/xtunnel-core-VERSION.apk (unsigned, packed with the apk of the OpenWrt SDK image as the SDK packs
# packages). It replaces the package xray-core:
#   /usr/bin/xray      xray from the pinned upstream source below, with the parts luci-app-xtunnel configures
#                      (src/xray/distro.go, trim.py) and a control socket for the balancer of the client's
#                      active link in place of the gRPC API (src/xray/control.go)
# The source and the Go module cache stay in the Docker volumes xtunnel-src and xtunnel-gocache.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=1.0.0-r1
XRAY=v26.3.27                                    # as the xray-core package of OpenWrt 25.12
GO_IMAGE=golang:1.26-bookworm
SDK_IMAGE=openwrt/sdk:x86-64-25.12.6               # packing
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

docker exec -i -e XRAY=$XRAY -e GOARCHES="$GOARCHES" $NAME bash -s <<'EOS'
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
W=/work
rm -rf $W/xray-src $W/core
git -C /src/xray archive --prefix=xray-src/ $XRAY | tar -x -C $W

# xray: only the parts of the JSON configuration that the package writes (trim.py)
python3 /work/trim.py $W/xray-src

# the executable: our files and xray's main packages as packages of it
C=$W/core
mkdir -p $C/xray
cp $W/src/main.go $C/
cp $W/src/xray/distro.go $W/src/xray/control.go $C/xray/
# run.go: the control socket once the instance runs (control.go)
for f in main.go run.go version.go; do sed 's/^package main$/package xray/; s/^func main() {$/func Main() {/; /main\/distro\/all"$/d; s/^\tdefer server.Close()$/&\n\tlistenControl(server)/' $W/xray-src/main/$f > $C/xray/$f; done
grep -q 'listenControl(server)' $C/xray/run.go
for f in x25519.go curve25519.go; do sed 's/^package all$/package xray/' $W/xray-src/main/commands/all/$f > $C/xray/$f; done
# the module path has the length of github.com/xtls/xray-core, which xray's errors cut off the name of the
# function that made them: the errors of run.go then start with "xray:" (the package of src/xray)
cat > $C/go.mod <<EOF
module xtunnel.local/xtunnelcore

go 1.26

require github.com/xtls/xray-core v0.0.0

replace github.com/xtls/xray-core => ../xray-src
EOF
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

# the packages: the executable
chmod 777 "$OUT"
for a in $ARCHES; do
	g=$(goarch "$a"); d="$OUT/pkg-$a"
	mkdir -p "$d/usr/bin"
	cp "$OUT/$g/xray" "$d/usr/bin/xray"; chmod 755 "$d/usr/bin/xray"
done
# as root in the container, in its own file system (owners and modes as packed)
docker run --rm --user 0:0 -v "$OUT:/out" "$SDK_IMAGE" sh -c '
	set -e
	APK=$PWD/staging_dir/host/bin/apk
	for o in /out/pkg-*; do
		a=${o#/out/pkg-}
		case $a in x86_64) g=amd64 ;; mips_24kc) g=mips ;; *) g=arm64 ;; esac
		d=/tmp/pkg-$a; rm -rf $d; cp -a $o $d
		P=$d/lib/apk/packages; mkdir -p $P
		(cd $d && find . -type f,l -printf "/%P\n" | sort) > /tmp/list && mv /tmp/list $P/xtunnel-core.list
		# the tor of earlier versions of this package: stopped at the upgrade (its files go with the old package)
		{
			echo "#!/bin/sh"
			echo "[ -n \"\${IPKG_INSTROOT}\" ] || { [ -x /etc/init.d/tor ] && /etc/init.d/tor stop >/dev/null 2>&1; kill \$(pidof tor) >/dev/null 2>&1; }"
			echo "exit 0"
		} > /tmp/pre-upgrade
		mkdir -p /out/apk/$a
		chown -R 0:0 $d
		find $d -type d -exec chmod 755 {} +
		sh -c "$APK mkpkg \
			--info \"name:xtunnel-core\" --info \"version:'"$VERSION"'\" \
			--info \"description:xray (the parts luci-app-xtunnel configures, with a control socket in place of the gRPC API), /usr/bin/xray\" \
			--info \"arch:$a\" --info \"license:MPL-2.0\" \
			--info \"origin:xtunnel-core\" --info \"url:https://github.com/nikiforov-org/OpenWRT-tunnel\" \
			--info \"maintainer:Evgenii Nikiforov\" \
			--info \"replaces:xray-core\" \
			--info \"depends:ca-bundle\" \
			--script pre-upgrade:/tmp/pre-upgrade \
			--files $d --output /out/apk/$a/xtunnel-core-'"$VERSION"'.apk"
	done'
for a in $ARCHES; do
	mkdir -p "$ROOT/dist/$a"
	rm -f "$ROOT/dist/$a"/xtunnel-core-*.apk
	cp -X "$OUT/apk/$a/xtunnel-core-$VERSION.apk" "$ROOT/dist/$a/"
	ls -l "$ROOT/dist/$a/xtunnel-core-$VERSION.apk"
done
