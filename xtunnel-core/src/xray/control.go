package xray

// The control socket of luci-app-xtunnel's client, in place of xray's gRPC API (not built in): the active
// link is the override of a balancer. xray run listens on the path in XTUNNEL_CONTROL (a Unix socket, root
// only) when it is set; "xray control" asks it.
//   bo BALANCER [TARGET]   the override target of the balancer (none without TARGET): "ok" or "error …"
//   bi BALANCER            "override TARGET" (empty without one) and "select TAG" per target of its selector

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/routing"
	"github.com/xtls/xray-core/main/commands/base"
)

const controlDefault = "/tmp/xtunnel-xray/control.sock"

func controlPath() string {
	if p := os.Getenv("XTUNNEL_CONTROL"); p != "" {
		return p
	}
	return controlDefault
}

// listenControl starts the control socket of a running instance (xray run, after Start)
func listenControl(server core.Server) {
	path := os.Getenv("XTUNNEL_CONTROL")
	inst, ok := server.(*core.Instance)
	if path == "" || !ok {
		return
	}
	router := inst.GetFeature(routing.RouterType())
	os.Remove(path)
	l, err := net.Listen("unix", path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "control socket:", err)
		return
	}
	os.Chmod(path, 0o600)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go answerControl(c, router)
		}
	}()
}

func answerControl(c net.Conn, router interface{}) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	line, _ := bufio.NewReader(c).ReadString('\n')
	f := strings.Fields(line)
	bo, canOverride := router.(routing.BalancerOverrider)
	switch {
	case len(f) >= 2 && len(f) <= 3 && f[0] == "bo" && canOverride:
		target := ""
		if len(f) == 3 {
			target = f[2]
		}
		if err := bo.SetOverrideTarget(f[1], target); err != nil {
			fmt.Fprintln(c, "error", err)
			return
		}
		fmt.Fprintln(c, "ok")
	case len(f) == 2 && f[0] == "bi" && canOverride:
		target, err := bo.GetOverrideTarget(f[1])
		if err != nil {
			fmt.Fprintln(c, "error", err)
			return
		}
		fmt.Fprintln(c, "override", target)
		if pt, ok := router.(routing.BalancerPrincipleTarget); ok {
			if tags, err := pt.GetPrincipleTarget(f[1]); err == nil {
				for _, t := range tags {
					fmt.Fprintln(c, "select", t)
				}
			}
		}
	default:
		fmt.Fprintln(c, "error usage: bo BALANCER [TARGET] | bi BALANCER")
	}
}

var cmdControl = &base.Command{
	UsageLine: "{{.Exec}} control [bo BALANCER [TARGET] | bi BALANCER]",
	Short:     "Ask the control socket of a running Xray (luci-app-xtunnel)",
	Long: `{{.Exec}} control sends one request to the control socket of a running Xray (XTUNNEL_CONTROL, else
` + controlDefault + `) and prints the answer:
  bo BALANCER [TARGET]   sets the override target of the balancer (clears it without TARGET)
  bi BALANCER            prints "override TARGET" and "select TAG" for every target of its selector
The exit code is 1 when the answer is an error or the socket does not answer.
`,
	Run: func(cmd *base.Command, args []string) {
		if len(args) < 2 || (args[0] != "bo" && args[0] != "bi") {
			base.Fatalf("usage: xray control bo BALANCER [TARGET] | bi BALANCER")
		}
		c, err := net.DialTimeout("unix", controlPath(), 5*time.Second)
		if err != nil {
			base.Fatalf("%s", err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(10 * time.Second))
		fmt.Fprintln(c, strings.Join(args, " "))
		s := bufio.NewScanner(c)
		failed := true
		for s.Scan() {
			line := s.Text()
			fmt.Println(line)
			if !strings.HasPrefix(line, "error") {
				failed = false
			}
		}
		if failed {
			base.SetExitStatus(1)
			base.Exit()
		}
	},
}
