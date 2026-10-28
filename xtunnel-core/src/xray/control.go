package xray

// The control socket of luci-app-xtunnel's client, in place of xray's gRPC API (not built in): the active
// link is the override of a balancer. xray run listens on the path in XTUNNEL_CONTROL (a Unix socket, root
// only) when it is set; "xray control" asks it.
//   bo BALANCER [TARGET]   the override target of the balancer (none without TARGET): "ok" or "error …"
//   bi BALANCER            "override TARGET" (empty without one) and "select TAG" per target of its selector
//   test FILE [ASSETDIR]   what "xray run -test" checks (the file loaded and an instance built, not started),
//                          inside the running process: "ok" or "error …"; ASSETDIR for ext: rules
//   x25519 [PRIVATE]       an X25519 key pair as "xray x25519 [-i PRIVATE]" prints it
//   version                "Xray VERSION"
// so that the scripts never start a second xray process while one runs.

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/xtls/xray-core/common/cmdarg"
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
	case len(f) >= 2 && len(f) <= 3 && f[0] == "test":
		c.SetDeadline(time.Now().Add(120 * time.Second))
		asset := ""
		if len(f) == 3 {
			asset = f[2]
		}
		if err := testConfig(f[1], asset); err != nil {
			fmt.Fprintln(c, "error", err)
			return
		}
		fmt.Fprintln(c, "ok")
	case len(f) >= 1 && len(f) <= 2 && f[0] == "x25519":
		var raw []byte
		if len(f) == 2 {
			var err error
			if raw, err = base64.RawURLEncoding.DecodeString(f[1]); err != nil || len(raw) != 32 {
				fmt.Fprintln(c, "error Invalid length of X25519 private key.")
				return
			}
		}
		priv, pub, _, err := genCurve25519(raw)
		if err != nil {
			fmt.Fprintln(c, "error", err)
			return
		}
		fmt.Fprintf(c, "PrivateKey: %s\nPassword (PublicKey): %s\n", base64.RawURLEncoding.EncodeToString(priv), base64.RawURLEncoding.EncodeToString(pub))
	case len(f) == 1 && f[0] == "version":
		fmt.Fprintln(c, "Xray", core.Version())
	default:
		fmt.Fprintln(c, "error usage: bo BALANCER [TARGET] | bi BALANCER | test FILE [ASSETDIR] | x25519 [PRIVATE] | version")
	}
}

var testLock sync.Mutex

// testConfig loads FILE and builds an instance of it without starting it, as "xray run -test" does. The log
// and reverse sections are left out of the instance: the log app replaces the process's log handler when it
// is built, the reverse portals start a cleanup task that their Close does not stop; both were checked when
// the file was loaded.
func testConfig(file, asset string) (err error) {
	testLock.Lock()
	defer testLock.Unlock()
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	if asset != "" {
		old, had := os.LookupEnv("XRAY_LOCATION_ASSET")
		os.Setenv("XRAY_LOCATION_ASSET", asset)
		defer func() {
			if had {
				os.Setenv("XRAY_LOCATION_ASSET", old)
			} else {
				os.Unsetenv("XRAY_LOCATION_ASSET")
			}
		}()
	}
	config, err := core.LoadConfig("json", cmdarg.Arg{file})
	if err != nil {
		return err
	}
	apps := config.App[:0]
	for _, a := range config.App {
		if strings.HasSuffix(a.Type, ".log.Config") || strings.HasSuffix(a.Type, ".reverse.Config") {
			continue
		}
		apps = append(apps, a)
	}
	config.App = apps
	instance, err := core.New(config)
	if err != nil {
		return err
	}
	return instance.Close()
}

var cmdControl = &base.Command{
	UsageLine: "{{.Exec}} control [bo BALANCER [TARGET] | bi BALANCER | test FILE [ASSETDIR] | x25519 [PRIVATE] | version]",
	Short:     "Ask the control socket of a running Xray (luci-app-xtunnel)",
	Long: `{{.Exec}} control sends one request to the control socket of a running Xray (XTUNNEL_CONTROL, else
` + controlDefault + `) and prints the answer:
  bo BALANCER [TARGET]   sets the override target of the balancer (clears it without TARGET)
  bi BALANCER            prints "override TARGET" and "select TAG" for every target of its selector
The exit code is 1 when the answer is an error or the socket does not answer.
`,
	Run: func(cmd *base.Command, args []string) {
		if len(args) < 1 {
			base.Fatalf("usage: xray control bo BALANCER [TARGET] | bi BALANCER | test FILE [ASSETDIR] | x25519 [PRIVATE] | version")
		}
		c, err := net.DialTimeout("unix", controlPath(), 5*time.Second)
		if err != nil {
			base.Fatalf("%s", err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(130 * time.Second))
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
