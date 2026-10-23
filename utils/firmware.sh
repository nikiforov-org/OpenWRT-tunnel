#!/bin/sh
# firmware.sh PROFILE [RELEASE]: an OpenWrt image for the device PROFILE (its profile name in the
# release, as on firmware-selector.openwrt.org) with the packages of the release's own images (the target's manifest:
# LuCI included) and luci-app-xtunnel from dist/ (run utils/build.sh first), made with the official Image Builder (Docker image openwrt/imagebuilder:TARGET-SUBTARGET-RELEASE).
# The images, the list of their packages (.manifest) and sha256sums go to firmware/PROFILE/
# (gitignored; older files there are deleted first). RELEASE: default 25.12.6.
# EXTRA (environment): more packages of the release for the image, e.g.
#   EXTRA='kmod-usb-net-cdc-ncm parted' firmware.sh PROFILE   (a USB modem's driver and parted)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROFILE=${1:?usage: firmware.sh PROFILE [RELEASE]}
RELEASE=${2:-25.12.6}
TUNNEL="luci-app-xtunnel"
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
OFFICIAL=$(curl -fsS "$URL/targets/$TARGET/openwrt-$RELEASE-$T-$S.manifest" | cut -d' ' -f1 | tr '\n' ' ') ||
	die "no manifest of $TARGET"
APKS=""
for p in $TUNNEL; do
	f=$(ls "$ROOT"/dist/"$p"-[0-9]*.apk 2>/dev/null | head -1)
	[ -n "$f" ] || die "no dist/$p-*.apk (run utils/build.sh)"
	APKS="$APKS $f"
done
echo "OpenWrt $RELEASE, $TARGET, profile $PROFILE${EXTRA:+, extra packages: $EXTRA}"

docker rm -f -v $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME "openwrt/imagebuilder:$T-$S-$RELEASE" sleep 7200 >/dev/null || die "docker run failed"
trap 'docker rm -f -v $NAME >/dev/null 2>&1' EXIT
for f in $APKS; do docker exec -i $NAME sh -c "cat > packages/$(basename "$f")" < "$f"; done
docker exec $NAME sh -c "make image PROFILE='$PROFILE' PACKAGES='$OFFICIAL $TUNNEL ${EXTRA:-}' BIN_DIR=/tmp/fw 2>&1" > /tmp/firmware-$PROFILE.log ||
	{ tail -30 /tmp/firmware-$PROFILE.log; die "make image failed (log /tmp/firmware-$PROFILE.log)"; }
mkdir -p "$OUT" && find "$OUT" -mindepth 1 -maxdepth 1 -type f -delete
docker exec $NAME sh -c 'cd /tmp/fw && tar cf - .' | tar xf - -C "$OUT" ||
	die "the images could not be copied"
ls -l "$OUT"
