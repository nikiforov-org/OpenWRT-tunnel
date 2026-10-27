#!/bin/sh
# certs.sh DEVICE save|restore HOST: the router's certificates in the directory config/devices/DEVICE/ of
# the repository (gitignored), as plain files under the paths they have on the router:
#   etc/xtunnel-ddns/acme  uacme's account key and its copy of every certificate
#   etc/ssl/xtunnel-ddns   the installed certificates (the web server, Hysteria2)
# save     replaces these directories in config/devices/DEVICE/ with the router's current ones; no older
#          copy is kept (one the router does not have keeps its saved copy)
# restore  puts them back on the router (owners and modes as the package creates them)
# HOST: the router's SSH address (its LAN address, or the address and port of a reverse access port of
# another router: HOST=192.168.123.123 PORT=22001), or docker:NAME for a stage container (utils/stage).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PATHS="etc/xtunnel-ddns/acme etc/ssl/xtunnel-ddns"

die() { echo "certs.sh: $*" >&2; exit 1; }
[ $# -ge 3 ] || die "usage: certs.sh DEVICE save|restore HOST"
DEVICE=$1 OP=$2 HOST=$3
case "$DEVICE" in *[!A-Za-z0-9_.-]*|.*|'') die "invalid device name: $DEVICE" ;; esac
DIR="$ROOT/config/devices/$DEVICE"
[ -r "$DIR/.env" ] || die "no $DIR/.env"
SSH_KEY=$(. "$DIR/.env"; echo "${SSH_KEY:-}")
ALIAS=$(. "$DIR/.env"; echo "${SSH_HOST_KEY_ALIAS:-}")   # the name its host key is known under (LAN addresses repeat)

# a command on the router
run() {
	if [ "${HOST#docker:}" != "$HOST" ]; then
		docker exec -i "${HOST#docker:}" sh -c "$1"
	else
		ssh -o BatchMode=yes ${PORT:+-p "$PORT"} ${ALIAS:+-o HostKeyAlias="$ALIAS"} ${SSH_KEY:+-i "$SSH_KEY"} "root@$HOST" "$1"
	fi
}

case "$OP" in
save)
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/certs.XXXXXX") || die "mktemp failed"
	trap 'rm -rf "$tmp"' EXIT
	run "cd / && tar cf - \$(for p in $PATHS; do [ -e \$p ] && echo \$p; done)" | tar xf - -C "$tmp" ||
		die "the router's files could not be read"
	[ -d "$tmp/etc/ssl/xtunnel-ddns" ] || die "no etc/ssl/xtunnel-ddns in the router's answer: nothing changed"
	for p in $PATHS; do
		# a directory the router does not have (yet) keeps its saved copy
		[ -e "$tmp/$p" ] || { [ -e "$DIR/$p" ] && echo "  $p: not on the router, the saved copy is kept"; continue; }
		rm -rf "$DIR/${p:?}"
		mkdir -p "$DIR/$(dirname "$p")" && mv "$tmp/$p" "$DIR/$p" || die "could not write $DIR/$p"
	done
	echo "saved to $DIR:"
	for c in "$DIR"/etc/ssl/xtunnel-ddns/*/fullchain.pem; do
		[ -r "$c" ] || continue
		printf '  %s: %s\n' "$(basename "$(dirname "$c")")" "$(openssl x509 -in "$c" -noout -enddate -issuer 2>/dev/null | tr '\n' ' ')"
	done
	;;
restore)
	present=""
	for p in $PATHS; do
		[ -e "$DIR/$p" ] && present="$present $p"
	done
	[ -n "$present" ] || die "nothing to restore from $DIR"
	# COPYFILE_DISABLE: no AppleDouble entries from macOS tar
	(cd "$DIR" && COPYFILE_DISABLE=1 tar cf - --exclude '._*' $present) | run 'tar xf - -C / -o &&
		{ [ ! -d /etc/xtunnel-ddns/acme ] || { chown -R root:root /etc/xtunnel-ddns/acme
			find /etc/xtunnel-ddns/acme -type d -exec chmod 755 {} \; ; find /etc/xtunnel-ddns/acme -type f -exec chmod 644 {} \;
			chmod 700 /etc/xtunnel-ddns/acme/private; find /etc/xtunnel-ddns/acme/private -type d -exec chmod 700 {} \;
			find /etc/xtunnel-ddns/acme/private -type f -exec chmod 600 {} \; ; }; } &&
		{ [ ! -d /etc/ssl/xtunnel-ddns ] || { chown -R root:root /etc/ssl/xtunnel-ddns
			find /etc/ssl/xtunnel-ddns -type d -exec chmod 700 {} \; ; find /etc/ssl/xtunnel-ddns -type f -exec chmod 600 {} \;
			find /etc/ssl/xtunnel-ddns -name fullchain.pem -exec chmod 644 {} \; ; }; } &&
		{ ls /etc/ssl/xtunnel-ddns 2>/dev/null || true; }' || die "restore failed"
	echo "restored:$present"
	;;
*) die "usage: certs.sh DEVICE save|restore HOST" ;;
esac
