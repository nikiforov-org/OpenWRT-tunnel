#!/usr/bin/env python3
# trim.py XRAY_SRC: takes the parts of xray's JSON configuration out that luci-app-xtunnel never writes, so
# that the code behind them is not linked: the protocols other than VLESS, Hysteria2, SOCKS, dokodemo-door,
# freedom, blackhole and DNS; the transports mKCP, gRPC, WebSocket and HTTPUpgrade; the finalmask types
# other than Salamander; the sections api (the gRPC API: the client's active link goes through the control
# socket of src/xray/control.go), metrics, stats, fakeDns, observatory, burstObservatory; the YAML
# and TOML configuration formats. The help of the command line is printed without text/template, and the
# header templates of the http outbound are taken as plain values (text/template is linked otherwise).
# Imports left unused are removed afterwards by build.sh (go build reports them).
import os, re, sys

SRC = sys.argv[1]
CONF = os.path.join(SRC, 'infra/conf')


def read(p):
	return open(p).read()


def write(p, s):
	open(p, 'w').write(s)


def drop_block(s, head):
	"""removes the block whose first line matches the regex head (up to the closing brace of its indentation)"""
	m = re.search(r'(?m)^(\t*)' + head + r'.*\{\n', s)
	if not m:
		raise SystemExit(f'trim.py: no block {head!r}')
	ind = m.group(1)
	end = s.index('\n' + ind + '}\n', m.end() - 1) + len(ind) + 3
	return s[:m.start()] + s[end:]


def drop_decl(s, name):
	"""removes a top-level type and its methods"""
	one = re.compile(r'(?m)^type ' + name + r' struct ?\{\}\n')
	s = one.sub('', s, 1) if one.search(s) else drop_block(s, r'type ' + name + r' struct ')
	while re.search(r'(?m)^func \(\w+ \*?' + name + r'\) ', s):
		s = drop_block(s, r'func \(\w+ \*?' + name + r'\) ')
	return s


def drop_lines(s, pattern):
	s2 = re.sub(r'(?m)^.*' + pattern + r'.*\n', '', s)
	if s2 == s:
		raise SystemExit(f'trim.py: no line {pattern!r}')
	return s2


# protocols: the JSON loaders of the others
for f in ('http.go', 'shadowsocks.go', 'vmess.go', 'trojan.go', 'wireguard.go', 'tun.go', 'loopback.go',
          'metrics.go', 'fakedns.go', 'observatory.go', 'grpc.go', 'init.go', 'api.go'):
	os.remove(os.path.join(CONF, f))
for f in os.listdir(CONF):
	if f.endswith('_test.go'):
		os.remove(os.path.join(CONF, f))
p = os.path.join(CONF, 'xray.go')
s = read(p)
for name in ('http', 'shadowsocks', 'vmess', 'trojan', 'wireguard', 'tun', 'loopback', 'mixed'):
	s = re.sub(r'\n\t\t"%s":\s+func\(\) interface\{\} \{[^\n]*\},' % name, '', s)
for field in ('API', 'Metrics', 'Stats', 'FakeDNS', 'Observatory', 'BurstObservatory'):
	s = drop_lines(s, r'^\t' + field + r'\s+\*\w+Config\s+`json:')
	s = drop_block(s, r'if o\.' + field + r' != nil ')
	s = drop_block(s, r'if c\.' + field + r' != nil ')
write(p, s)

# transports and finalmask types
p = os.path.join(CONF, 'transport_internet.go')
s = read(p)
for field in ('KCPSettings', 'GRPCSettings', 'WSSettings', 'HTTPUPGRADESettings'):
	s = drop_lines(s, r'^\t' + field + r'\s+\*\w+\s+`json:')
	s = drop_block(s, r'if c\.' + field + r' != nil ')
for name in ('KCPConfig', 'WebSocketConfig', 'HttpUpgradeConfig', 'HeaderCustomTCP', 'TCPItem', 'FragmentMask',
             'NoiseItem', 'NoiseMask', 'UDPItem', 'HeaderCustomUDP', 'Dns', 'Dtls', 'Srtp', 'Utp', 'Wechat',
             'Wireguard', 'Original', 'Aes128Gcm', 'Sudoku', 'Xdns', 'Xicmp'):
	s = drop_decl(s, name)
s = re.sub(r'\n\t\t"(header-[a-z]+|fragment|sudoku|mkcp-[a-z0-9]+|noise|xdns|xicmp)":\s+func\(\) interface\{\} \{[^\n]*\},', '', s)
s = drop_block(s, r'func PraseByteSlice\(')
write(p, s)

# the help of the command line without text/template
p = os.path.join(SRC, 'main/commands/base/help.go')
s = read(p)
start = s.index('// tmpl executes the given template text on data, writing the result to w.')
end = s.index('func capitalize(s string) string {')
s = s[:start] + '''// tmpl writes the help and the usage of a command as their templates above do, and any other text
// with {{.Exec}} and {{.LongName}} replaced
func tmpl(w io.Writer, text string, data interface{}) {
	d, ok := data.(tmplData)
	if ok && text == helpTemplate {
		if d.Runnable() {
			fmt.Fprintf(w, "usage: %s\\n\\n", d.UsageLine)
		}
		fmt.Fprintln(w, strings.TrimSpace(d.Long))
		return
	}
	if ok && text == usageTemplate {
		fmt.Fprintf(w, "%s\\n\\nUsage:\\n\\n\\t%s <command> [arguments]\\n\\nThe commands are:\\n", strings.TrimSpace(d.Long), d.UsageLine)
		for _, c := range d.Commands {
			if c.Short != "" && (c.Runnable() || len(c.Commands) > 0) {
				fmt.Fprintf(w, "\\n\\t%-*s %s", d.CommandsWidth, c.Name(), c.Short)
			}
		}
		name := d.LongName()
		if name != "" {
			name = " " + name
		}
		fmt.Fprintf(w, "\\n\\nUse \\"%s help%s <command>\\" for more information about a command.\\n", d.Exec, name)
		return
	}
	if ok {
		text = strings.ReplaceAll(text, "{{.Exec}}", d.Exec)
		text = strings.ReplaceAll(text, "{{.LongName}}", d.LongName())
	}
	io.WriteString(w, text)
}

''' + s[end:]
write(p, s)

# the header values of the http outbound as given
p = os.path.join(SRC, 'proxy/http/client.go')
s = read(p)
start = s.index('// fillRequestHeader will fill out the template of the headers')
end = s.index('\n}\n', start) + 3
s = s[:start] + '''// fillRequestHeader: the header values as given
func fillRequestHeader(ctx context.Context, header []*Header) ([]*Header, error) {
	return header, nil
}
''' + s[end:]
write(p, s)

# the configuration in JSON only: the YAML and TOML decoders (and their libraries) out
p = os.path.join(CONF, 'serial/loader.go')
s = read(p)
for name in ('DecodeTOMLConfig', 'LoadTOMLConfig', 'DecodeYAMLConfig', 'LoadYAMLConfig'):
	s = drop_block(s, r'func ' + name + r'\(')
write(p, s)
p = os.path.join(CONF, 'serial/builder.go')
write(p, drop_lines(read(p), r'ReaderDecoderByFormat\["(yaml|toml)"\]'))
