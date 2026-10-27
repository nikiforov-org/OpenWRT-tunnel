// xtunnel-core: the xray executable (src/xray: xray's main packages with the parts luci-app-xtunnel
// configures, and a control socket for the balancer of the client's active link).
package main

import "xtunnel.local/xtunnelcore/xray"

func main() {
	xray.Main()
}
