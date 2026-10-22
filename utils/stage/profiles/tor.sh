# profile tor: a router for the onion service tests: the Docker network as wan, luci-app-tunnel-tor
# installed (configured by the tests).
"$STAGE" create "$N" wan || exit 1
"$STAGE" install "$N" tor
