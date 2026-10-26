#!/bin/sh
# zte-mf286r/build.sh [RELEASE]: the packages of this directory, the ZTE MF286R's own (its internal LTE module and
# the USB socket on its case; README.md), with the OpenWrt SDK image of its target ath79/nand (package architecture
# mips_24kc) into dist/zte-mf286r/: mf286r-modem, luci-app-ic, luci-app-sms and mf286r-usb (noarch) and kmod-fs-apfs,
# a kernel module built against the release's kernel in the SDK. utils/firmware.sh zte_mf286r puts them into the
# image. RELEASE: default 25.12.6.
set -eu
REL="${1:-25.12.6}"
SDK="openwrt/sdk:ath79-nand-${REL}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/dist/zte-mf286r"
mkdir -p "$OUT"

docker run --rm \
	-v "$REPO/zte-mf286r:/custom:ro" \
	-v "$OUT:/out" \
	"$SDK" sh -e -c '
		cd /builder
		# the package sources with normalised modes (the host file system may report 700 for everything; the
		# Makefiles set the modes of the installed files)
		rm -rf /tmp/custom && mkdir -p /tmp/custom
		PKGS=""
		for d in /custom/*/; do
			[ -f "${d}Makefile" ] || continue
			cp -r "$d" /tmp/custom/
			PKGS="$PKGS $(basename "$d")"
		done
		find /tmp/custom -name "._*" -delete        # AppleDouble files of an exFAT source tree
		find /tmp/custom -type d -exec chmod 755 {} +
		find /tmp/custom -type f -exec chmod 644 {} +
		[ -n "$PKGS" ] || { echo "no packages in zte-mf286r/"; exit 1; }

		cp feeds.conf.default feeds.conf
		echo "src-link custom /tmp/custom" >> feeds.conf
		./scripts/feeds update custom
		./scripts/feeds install $PKGS

		# The package tree of the kernel would pack every module of the kernel for the kmod-* dependencies of
		# these packages; kmod-fs-apfs builds against the kernel tree of the SDK (build_dir), which stays.
		rm -rf package/kernel/linux
		make defconfig >/dev/null
		# The packing of a kernel module checks the modules it references (modinfo depends) against the provides
		# lists of its kmod-* dependencies, which the removed tree would have made: the two of kmod-fs-apfs
		# (depends=libcrc32c,nls_base) are written here.
		P=$(ls -d staging_dir/target-*)/pkginfo; mkdir -p "$P"
		echo libcrc32c.ko > "$P/kmod-lib-crc32c.provides"
		echo nls_base.ko > "$P/kmod-nls-base.provides"
		for p in $PKGS; do
			make "package/$p/compile" V=s
		done

		rm -f /out/*.apk
		for p in $PKGS; do find bin -name "$p-[0-9]*.apk" -exec cp {} /out/ \; ; done
		ls -l /out
	'
