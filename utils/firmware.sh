#!/bin/sh
# firmware.sh PROFILE [RELEASE]: an OpenWrt image for the device PROFILE (its profile name in the
# release, as on firmware-selector.openwrt.org) with the packages of the release's own images (the target's manifest:
# LuCI included) but those in DROP, and luci-app-xtunnel with xtunnel-core from dist/ (run utils/build.sh and
# xtunnel-core/build.sh first), made with the official Image Builder (Docker image openwrt/imagebuilder:TARGET-SUBTARGET-RELEASE).
# The images, the list of their packages (.manifest) and sha256sums go to firmware/PROFILE/
# (gitignored; older files there are deleted first). RELEASE: default 25.12.6.
# A device with packages of its own has a directory of the repository named after its profile with hyphens
# (zte-mf286r for zte_mf286r): the image gets the apks of dist/<directory>/ (run <directory>/build.sh first)
# and the packages of the release listed in <directory>/packages (one per line, # comments).
# EXTRA (environment): more packages of the release for the image, e.g.
#   EXTRA='kmod-usb-net-cdc-ncm parted' firmware.sh PROFILE   (a USB modem's driver and parted)
# CPUS (environment): at most that many cores for the Image Builder (e.g. 1.5 while stages run tests).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROFILE=${1:?usage: firmware.sh PROFILE [RELEASE]}
RELEASE=${2:-25.12.6}
TUNNEL="luci-app-xtunnel"
# packages of the release's image that the routers here do not use: the attended sysupgrade (its server
# builds images of the release's packages only) and PPP (the uplinks are DHCP)
DROP="luci-app-attendedsysupgrade attendedsysupgrade-common owut ucode-mod-uclient luci-proto-ppp ppp ppp-mod-pppoe kmod-ppp kmod-pppoe kmod-pppox kmod-slhc"
URL="https://downloads.openwrt.org/releases/$RELEASE"
OUT="$ROOT/firmware/$PROFILE"
NAME=tunnel-firmware

die() { echo "firmware.sh: $*" >&2; exit 1; }

TARGET=$(curl -fsS "$URL/.overview.json" | python3 -c '
import json, sys
p = [x for x in json.load(sys.stdin)["profiles"] if x["id"] == sys.argv[1]]
print(p[0]["target"] if p else "")' "$PROFILE") || die "no $URL/.overview.json"
[ -n "$TARGET" ] || die "OpenWrt $RELEASE has no profile $PROFILE"
T=${TARGET%/*} S=${TARGET#*/}
OFFICIAL=$(curl -fsS "$URL/targets/$TARGET/openwrt-$RELEASE-$T-$S.manifest" | cut -d' ' -f1 | grep -vxF "$(echo $DROP | tr ' ' '\n')" | tr '\n' ' ') ||
	die "no manifest of $TARGET"
APKS=""
for p in $TUNNEL; do
	f=$(ls "$ROOT"/dist/"$p"-[0-9]*.apk 2>/dev/null | head -1)
	[ -n "$f" ] || die "no dist/$p-*.apk (run utils/build.sh)"
	APKS="$APKS $f"
done
DEV=$(echo "$PROFILE" | tr _ -)
DEVPKGS=""
if [ -d "$ROOT/$DEV" ]; then
	for f in "$ROOT/dist/$DEV"/*.apk; do
		[ -f "$f" ] || die "no dist/$DEV/*.apk (run $DEV/build.sh)"
		APKS="$APKS $f"
		DEVPKGS="$DEVPKGS $(basename "$f" | sed 's/-[0-9].*//')"
	done
	[ ! -f "$ROOT/$DEV/packages" ] || DEVPKGS="$DEVPKGS $(sed 's/#.*//' "$ROOT/$DEV/packages" | tr '\n' ' ')"
fi
echo "OpenWrt $RELEASE, $TARGET, profile $PROFILE${DEVPKGS:+, the packages of $DEV/}${EXTRA:+, extra packages: $EXTRA}"

docker rm -f -v $NAME >/dev/null 2>&1 || true
docker run -d ${CPUS:+--cpus $CPUS} --name $NAME "openwrt/imagebuilder:$T-$S-$RELEASE" sleep 7200 >/dev/null || die "docker run failed"
trap 'docker rm -f -v $NAME >/dev/null 2>&1' EXIT
for f in $APKS; do docker exec -i $NAME sh -c "cat > packages/$(basename "$f")" < "$f"; done
# xtunnel-core of the target's package architecture
ARCH=$(docker exec $NAME sh -c "sed -n 's/^CONFIG_TARGET_ARCH_PACKAGES=\"\(.*\)\"$/\1/p' .config")
CORE=$(ls "$ROOT"/dist/"$ARCH"/xtunnel-core-[0-9]*.apk 2>/dev/null | head -1)
[ -n "$CORE" ] || die "no dist/$ARCH/xtunnel-core-*.apk (run xtunnel-core/build.sh $ARCH)"
docker exec -i $NAME sh -c "cat > packages/$(basename "$CORE")" < "$CORE"
docker exec $NAME sh -c "make image PROFILE='$PROFILE' PACKAGES='$OFFICIAL $TUNNEL xtunnel-core $DEVPKGS $(for p in $DROP; do printf -- '-%s ' $p; done)${EXTRA:-}' BIN_DIR=/tmp/fw 2>&1" > /tmp/firmware-$PROFILE.log ||
	{ tail -30 /tmp/firmware-$PROFILE.log; die "make image failed (log /tmp/firmware-$PROFILE.log)"; }
mkdir -p "$OUT" && find "$OUT" -mindepth 1 -maxdepth 1 -type f -delete
docker exec $NAME sh -c 'cd /tmp/fw && tar cf - .' | tar xf - -C "$OUT" ||
	die "the images could not be copied"
ls -l "$OUT"
