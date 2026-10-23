# profile tor: a router for the onion service tests: the Docker network as wan, luci-app-xtunnel
# installed (its Tor part configured by the tests).
"$STAGE" create "$N" wan || exit 1
"$STAGE" install "$N" xtunnel
