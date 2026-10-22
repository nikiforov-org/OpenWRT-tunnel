#!/bin/sh
# Starts tor with /etc/tor/torrc (written by tor-client; a SOCKS port only until then). tor drops to
# the tor user itself ("User tor"); its notices go to /var/lib/tor/notice.log, which tor-client reads.
[ -f /etc/tor/torrc ] || printf 'User tor\nSocksPort 127.0.0.1:9050\nDataDirectory /var/lib/tor\nClientOnionAuthDir /etc/tor/auth\nLog notice file /var/lib/tor/notice.log\n' > /etc/tor/torrc
: > /var/lib/tor/notice.log
chown tor:tor /var/lib/tor/notice.log
exec tor -f /etc/tor/torrc
