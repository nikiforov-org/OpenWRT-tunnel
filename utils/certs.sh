#!/bin/sh
# certs.sh DEVICE save|restore [HOST]: the router's certificates and onion service keys in the
# directory config/devices/DEVICE/ of the repository (gitignored), as plain files under the paths they
# have on the router:
#   etc/tunnel-ddns/acme   uacme's account key and its copy of every certificate
#   etc/ssl/tunnel-ddns    the installed certificates (the web server, Hysteria2)
#   etc/tor/tunnel-tor     the onion service's keys (its address) and the authorized clients
# save     replaces these directories in config/devices/DEVICE/ with the router's current ones; no older
#          copy is kept (one the router does not have keeps its saved copy)
# restore  puts them back on the router (owners and modes as the packages create them)
# HOST: the router's SSH address, for a DEV check on its LAN, or docker:NAME for a stage container
# (utils/stage); without HOST the router is reached over Tor (utils/tor-client/tor-client DEVICE,
# settings in config/devices/DEVICE/.env).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PATHS="etc/tunnel-ddns/acme etc/ssl/tunnel-ddns etc/tor/tunnel-tor"

die() { echo "certs.sh: $*" >&2; exit 1; }
[ $# -ge 2 ] || die "usage: certs.sh DEVICE save|restore [HOST]"
DEVICE=$1 OP=$2 HOST=${3:-}
case "$DEVICE" in *[!A-Za-z0-9_.-]*|.*|'') die "invalid device name: $DEVICE" ;; esac
DIR="$ROOT/config/devices/$DEVICE"
[ -r "$DIR/.env" ] || die "no $DIR/.env"
SSH_KEY=$(. "$DIR/.env"; echo "${SSH_KEY:-}")
ALIAS=$(. "$DIR/.env"; echo "${SSH_HOST_KEY_ALIAS:-}")   # the name its host key is known under (LAN addresses repeat)

# a command on the router
run() {
	if [ "${HOST#docker:}" != "$HOST" ]; then
		docker exec -i "${HOST#docker:}" sh -c "$1"
	elif [ -n "$HOST" ]; then
		ssh -o BatchMode=yes ${ALIAS:+-o HostKeyAlias="$ALIAS"} ${SSH_KEY:+-i "$SSH_KEY"} "root@$HOST" "$1"
	else
		"$ROOT/utils/tor-client/tor-client" "$DEVICE" "$1"
	fi
}

case "$OP" in
save)
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/certs.XXXXXX") || die "mktemp failed"
	trap 'rm -rf "$tmp"' EXIT
	run "cd / && tar cf - \$(for p in $PATHS; do [ -e \$p ] && echo \$p; done)" | tar xf - -C "$tmp" ||
		die "the router's files could not be read"
	[ -d "$tmp/etc/ssl/tunnel-ddns" ] || die "no etc/ssl/tunnel-ddns in the router's answer: nothing changed"
	for p in $PATHS; do
		# a directory the router does not have (yet) keeps its saved copy
		[ -e "$tmp/$p" ] || { [ -e "$DIR/$p" ] && echo "  $p: not on the router, the saved copy is kept"; continue; }
		rm -rf "$DIR/${p:?}"
		mkdir -p "$DIR/$(dirname "$p")" && mv "$tmp/$p" "$DIR/$p" || die "could not write $DIR/$p"
	done
	echo "saved to $DIR:"
	for c in "$DIR"/etc/ssl/tunnel-ddns/*/fullchain.pem; do
		[ -r "$c" ] || continue
		printf '  %s: %s\n' "$(basename "$(dirname "$c")")" "$(openssl x509 -in "$c" -noout -enddate -issuer 2>/dev/null | tr '\n' ' ')"
	done
	[ -r "$DIR/etc/tor/tunnel-tor/hostname" ] && echo "  onion service keys: etc/tor/tunnel-tor"
	;;
restore)
	# the onion service keys only where the tor package is installed: the directory belongs to its user
	tor=$(run 'id tor >/dev/null 2>&1 && echo yes')
	present=""
	for p in $PATHS; do
		[ -e "$DIR/$p" ] || continue
		if [ "$p" = etc/tor/tunnel-tor ] && [ "$tor" != yes ]; then
			echo "onion service keys skipped: the router has no tor user (install luci-app-tunnel-tor, then restore again)"
			continue
		fi
		present="$present $p"
	done
	[ -n "$present" ] || die "nothing to restore from $DIR"
	# COPYFILE_DISABLE: no AppleDouble entries from macOS tar
	(cd "$DIR" && COPYFILE_DISABLE=1 tar cf - --exclude '._*' $present) | run 'tar xf - -C / -o &&
		{ [ ! -d /etc/tunnel-ddns/acme ] || { chown -R root:root /etc/tunnel-ddns/acme
			find /etc/tunnel-ddns/acme -type d -exec chmod 755 {} \; ; find /etc/tunnel-ddns/acme -type f -exec chmod 644 {} \;
			chmod 700 /etc/tunnel-ddns/acme/private; find /etc/tunnel-ddns/acme/private -type d -exec chmod 700 {} \;
			find /etc/tunnel-ddns/acme/private -type f -exec chmod 600 {} \; ; }; } &&
		{ [ ! -d /etc/ssl/tunnel-ddns ] || { chown -R root:root /etc/ssl/tunnel-ddns
			find /etc/ssl/tunnel-ddns -type d -exec chmod 700 {} \; ; find /etc/ssl/tunnel-ddns -type f -exec chmod 600 {} \;
			find /etc/ssl/tunnel-ddns -name fullchain.pem -exec chmod 644 {} \; ; }; } &&
		{ [ ! -d /etc/tor/tunnel-tor ] || ! id tor >/dev/null 2>&1 || { chown -R tor:tor /etc/tor/tunnel-tor
			find /etc/tor/tunnel-tor -type d -exec chmod 700 {} \; ; find /etc/tor/tunnel-tor -type f -exec chmod 600 {} \; ; }; } &&
		{ ls /etc/ssl/tunnel-ddns 2>/dev/null || true; }' || die "restore failed"
	echo "restored:$present"
	;;
*) die "usage: certs.sh DEVICE save|restore [HOST]" ;;
esac
