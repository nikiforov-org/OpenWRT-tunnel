// xtunnel-core: one executable for xray and lyrebird (the pluggable transports of tor: obfs4, meek_lite,
// snowflake), chosen by the name it is started under: lyrebird runs lyrebird, any other name xray. The two
// share one Go runtime and one copy of the libraries both use (TLS, QUIC, protobuf), and the processes share
// the executable's pages in memory.
package main

import (
	"os"
	"path/filepath"

	"xtunnel.local/xtunnelcore/lyrebird"
	"xtunnel.local/xtunnelcore/xray"
)

func main() {
	if filepath.Base(os.Args[0]) == "lyrebird" {
		lyrebird.Main()
		return
	}
	xray.Main()
}
