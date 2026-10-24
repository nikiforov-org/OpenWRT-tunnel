#!/bin/sh
set -eu

REL="${1:-25.12.6}"
SDK="openwrt/sdk:x86-64-${REL}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$REPO/dist"

# Fresh bridges for luci-app-xtunnel and luci-app-tunnel-tor (the router's tor uses them until its first bridge update): what
# bridges-update asks on the router, the moat API of bridges.torproject.org for the country
# BRIDGE_COUNTRY (default ru), through the tor client of utils/tor-client, else directly. The answer's
# obfs4, meek_lite and snowflake lines first, then those of the package's bridges.txt, unique by
# transport + address + fingerprint, at most 12 per transport. The list goes into the package being built
# and into dist/tunnel-tor-bridges.txt; the files in the repository stay as they are. Without a usable
# answer the build stops.
BRIDGES="$REPO/dist/tunnel-tor-bridges.txt"
rm -f "$BRIDGES"
SHIPPED="$REPO/luci-app-xtunnel/root/usr/share/xtunnel-tor/bridges.txt"
[ -f "$SHIPPED" ] || SHIPPED="$REPO/luci-app-tunnel-tor/root/usr/share/tunnel-tor/bridges.txt"
if [ -f "$SHIPPED" ]; then
	C="${BRIDGE_COUNTRY:-ru}"
	API=https://bridges.torproject.org/moat/circumvention/settings
	ANS=$(mktemp)
	if "$REPO/utils/tor-client/tor-client" --start &&
		docker run --rm --network container:tunnel-tor-client curlimages/curl:latest -s -m 60 -X POST \
			-H 'Content-Type: application/json' -d "{\"country\":\"$C\"}" --socks5-hostname 127.0.0.1:9050 "$API" > "$ANS" &&
		[ -s "$ANS" ]; then
		VIA=tor
	elif curl -s -m 40 -X POST -H 'Content-Type: application/json' -d "{\"country\":\"$C\"}" "$API" > "$ANS" && [ -s "$ANS" ]; then
		VIA=direct
	else
		rm -f "$ANS"
		echo "build.sh: bridges.torproject.org was reached neither through tor nor directly" >&2
		exit 1
	fi
	python3 - "$ANS" "$SHIPPED" > "$BRIDGES" <<'PY' ||
import json, re, sys
try:
	ans = json.load(open(sys.argv[1]))
except ValueError:
	sys.exit('build.sh: the answer of bridges.torproject.org is not JSON')
VALID = re.compile(r'^(obfs4|snowflake|meek_lite|webtunnel) [^ ]+:[0-9]+ [0-9A-Fa-f]{40}( [^ ]+)*$')
VANILLA = re.compile(r'^[^ ]+:[0-9]+ [0-9A-Fa-f]{40}$')
PLUGINS = ('obfs4', 'meek_lite', 'snowflake')   # the transports the package's dependencies have plugins for
def valid(l): return VALID.match(l) or VANILLA.match(l)
def transport(l): return 'vanilla' if ':' in l.split(' ')[0] else l.split(' ')[0]
def key(l): return ' '.join(l.split(' ')[:2] if transport(l) == 'vanilla' else l.split(' ')[:3]).upper()
fresh = []
for s in ((ans.get('settings') or []) if isinstance(ans, dict) else []):
	for l in ((s or {}).get('bridges') or {}).get('bridge_strings') or []:
		l = l.strip()
		if valid(l) and (transport(l) == 'vanilla' or transport(l) in PLUGINS):
			fresh.append(l)
if not fresh:
	sys.exit('build.sh: no usable bridge lines in the answer of bridges.torproject.org')
shipped = [re.sub(r'^Bridge +', '', x.strip()) for x in open(sys.argv[2]).read().splitlines()]
out, seen, count = [], set(), {}
for l in fresh + [x for x in shipped if x and valid(x)]:
	k = key(l)
	if k in seen:
		continue
	seen.add(k)
	count[transport(l)] = count.get(transport(l), 0) + 1
	if count[transport(l)] <= 12:
		out.append(l)
sys.stderr.write('%d lines in the answer, the list: %s\n' % (len(fresh), ', '.join('%s %d' % (t, min(n, 12)) for t, n in sorted(count.items()))))
print('\n'.join('Bridge ' + l for l in out))
PY
		{ rm -f "$ANS" "$BRIDGES"; exit 1; }
	rm -f "$ANS"
	echo "bridges for the tor packages: from bridges.torproject.org ($VIA, $C), $(grep -c . "$BRIDGES") lines"
fi

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
		# the bridge list fetched above replaces the one of the source tree in the package
		if [ -f /out/tunnel-tor-bridges.txt ]; then
			[ -d /tmp/custom/luci-app-xtunnel ] && cp /out/tunnel-tor-bridges.txt /tmp/custom/luci-app-xtunnel/root/usr/share/xtunnel-tor/bridges.txt
			[ -d /tmp/custom/luci-app-tunnel-tor ] && cp /out/tunnel-tor-bridges.txt /tmp/custom/luci-app-tunnel-tor/root/usr/share/tunnel-tor/bridges.txt
		fi
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
