# Take the modem's AT control-port lock for the lifetime of this process.
#
# Sourced by /lib/netifd/proto/ncm.sh (patched in by 90-mf286r-at-lock) so that
# netifd's dialling takes turns with everything else that drives /dev/ttyACM0 —
# there is only one such port on this device. See /usr/bin/modem-at for the full story.
#
# This wait is UNBOUNDED, unlike the one in modem-at/modem-atlock, and that asymmetry is the
# whole point: dialling is the highest-priority user of the port and the only one
# that cannot survive a garbled exchange. Measured with a competitor hammering the
# port: a bounded wait expired, ncm.sh dialled anyway, gcom read the competitor's
# leftover "+CSQ:" reply instead of its own, and netifd gave up with "Unsupported
# modem" — the uplink stayed down. Waiting instead cannot produce that, because
# every other holder is short-lived by construction (modem-at bounds each command,
# sms_tool has its own alarm), so there is nothing here to wait on forever.
#
# The descriptor is opened and never closed, so the lock is released when the
# handler process exits, however it exits.
mkdir -p /var/lock
exec 9>/var/lock/at-modem.lock
flock 9
