#!/bin/sh
set -eu

REL="${1:-25.12.6}"
SDK="openwrt/sdk:x86-64-${REL}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$REPO/dist"

docker run --rm \
	-v "$REPO:/custom:ro" \
	-v "$REPO/dist:/out" \
	"$SDK" sh -e -c '
		cd /builder

		# Copy the package sources and normalise file modes (the host filesystem may
		# report 700 for everything): 644 for files, 755 for directories and scripts.
		rm -rf /tmp/custom && mkdir -p /tmp/custom
		PKGS=""
		for d in /custom/luci-app-xtunnel/ /custom/luci-app-tunnel-*/; do
			[ -f "${d}Makefile" ] || continue
			cp -r "$d" /tmp/custom/
			PKGS="$PKGS $(basename "$d")"
		done
		find /tmp/custom -name "._*" -delete        # AppleDouble files of an exFAT source tree
		# the comment lines of the ucode scripts stay in the source tree only
		[ -d /tmp/custom/luci-app-xtunnel ] && python3 /custom/utils/strip-ucode.py /tmp/custom/luci-app-xtunnel/root
		find /tmp/custom -type d -exec chmod 755 {} +
		find /tmp/custom -type f -exec chmod 644 {} +
		find /tmp/custom \( -path "*/root/etc/init.d/*" -o -path "*/root/usr/libexec/*" \
			-o -path "*/root/usr/bin/*" -o -path "*/root/usr/sbin/*" \
			-o -path "*/root/etc/hotplug.d/*" -o -path "*/root/etc/uci-defaults/*" \
			-o -path "*/root/usr/share/www/*/cgi-bin/*" \) \
			-type f -exec chmod 755 {} +

		cp feeds.conf.default feeds.conf
		echo "src-link custom /tmp/custom" >> feeds.conf
		[ -n "$PKGS" ] || { echo "no luci-app-xtunnel or luci-app-tunnel-* packages found"; exit 1; }

		./scripts/feeds update luci custom
		./scripts/feeds install $PKGS

		# Kernel modules are runtime dependencies only, like xray-core (the packages are
		# noarch): without the SDK package tree of the kernel, a dependency on a kmod-*
		# package stays in the package metadata and no longer makes the SDK pack all of
		# its kernel modules first.
		rm -rf package/kernel/linux
		make defconfig >/dev/null
		for p in $PKGS; do
			make "package/$p/compile" V=s
		done

		rm -f /out/*.apk
		find bin -path "*/custom/*" -name "*.apk" -exec cp {} /out/ \;
		ls -l /out
	'
