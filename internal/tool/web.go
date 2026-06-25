package tool

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// webFetchTool fetches a public http(s) URL and returns its text. Read-only and
// concurrency-safe (independent fetches), so it is available in plan mode. It
// guards against SSRF by refusing loopback/private/link-local addresses.
type webFetchTool struct{ Base }

// NewWebFetch returns the web_fetch tool.
func NewWebFetch() *webFetchTool {
	return &webFetchTool{Base{
		ToolName: "web_fetch",
		ToolDescription: "Fetch a public http(s) URL and return its content as text (HTML is reduced " +
			"to readable text). For external docs/pages; private and link-local addresses are refused.",
		ReadOnly:        true,
		ConcurrencySafe: true,
		ToolSchema: obj(props{
			"url": strProp("Absolute http(s) URL to fetch."),
		}, "url"),
	}}
}

const (
	webFetchTimeout  = 15 * time.Second
	webFetchMaxBytes = 2 << 20 // 2 MiB read cap
	webFetchTextCap  = 100_000 // chars returned
)

func (webFetchTool) Exec(ctx context.Context, input map[string]any, _ ExecContext) (Result, error) {
	u, err := url.Parse(strings.TrimSpace(strArg(input, "url")))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return errResult("url must be an absolute http(s) URL")
	}
	if err := guardPublicHost(u.Hostname()); err != nil {
		return errResult("%v", err)
	}
	cctx, cancel := context.WithTimeout(ctx, webFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return errResult("%v", err)
	}
	req.Header.Set("User-Agent", "carrier-web-fetch/1.0")
	resp, err := webClient.Do(req)
	if err != nil {
		return errResult("%v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, webFetchMaxBytes))
	text := htmlToText(string(body))
	return Result{
		Content: fmt.Sprintf("HTTP %d  %s\n\n%s", resp.StatusCode, u.String(), text),
		IsError: resp.StatusCode >= 400,
	}, nil
}

// nonPublicNets are special-use ranges NOT covered by the net.IP predicates
// below (which only catch loopback/private/link-local/multicast/unspecified) but
// that must never be an SSRF target — most notably 100.64.0.0/10 (carrier-grade
// NAT, often internal infra), plus NAT64, documentation, benchmark, reserved,
// and broadcast ranges. Parsed once at startup.
var nonPublicNets = parseCIDRs(
	"0.0.0.0/8",          // "this host on this network" (RFC 1122)
	"100.64.0.0/10",      // carrier-grade NAT / shared address space (RFC 6598)
	"192.0.0.0/24",       // IETF protocol assignments
	"192.0.2.0/24",       // TEST-NET-1 (documentation)
	"192.88.99.0/24",     // 6to4 relay anycast (deprecated)
	"198.18.0.0/15",      // benchmarking (RFC 2544)
	"198.51.100.0/24",    // TEST-NET-2
	"203.0.113.0/24",     // TEST-NET-3
	"240.0.0.0/4",        // reserved / class E
	"255.255.255.255/32", // limited broadcast
	"64:ff9b::/96",       // NAT64 (can embed a private IPv4)
	"100::/64",           // discard-only
	"2001:db8::/32",      // documentation
)

func parseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	return out
}

// isPublicIP reports whether ip is a routable public address. It rejects the
// net.IP special categories AND the extra special-use ranges in nonPublicNets.
func isPublicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, n := range nonPublicNets {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

// guardPublicHost is a fast, friendly pre-check for obviously-private hosts. It
// is NOT the security boundary — DNS can rebind between this lookup and the
// actual dial — so the real enforcement is in webClient's DialContext, which
// validates and connects to the SAME resolved IP.
func guardPublicHost(host string) error {
	if host == "" {
		return fmt.Errorf("missing host")
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("cannot resolve host %q", host)
	}
	for _, ip := range ips {
		if !isPublicIP(ip) {
			return fmt.Errorf("refusing to fetch a private/loopback address: %s", host)
		}
	}
	return nil
}

// webClient enforces SSRF protection at DIAL time (closing the DNS-rebinding
// hole): for every connection — including redirects — it resolves the host,
// rejects non-public IPs, and dials the validated IP literal so no second
// resolution can swap in a private address.
var webClient = &http.Client{
	Timeout: webFetchTimeout,
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			var d net.Dialer
			var lastErr error = fmt.Errorf("no usable address for host %q", host)
			for _, ipa := range ips {
				if !isPublicIP(ipa.IP) {
					lastErr = fmt.Errorf("refusing to connect to a private/loopback address: %s (%s)", host, ipa.IP)
					continue
				}
				conn, derr := d.DialContext(ctx, network, net.JoinHostPort(ipa.IP.String(), port))
				if derr == nil {
					return conn, nil
				}
				lastErr = derr
			}
			return nil, lastErr
		},
	},
	CheckRedirect: func(_ *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return nil // per-connection IP safety is enforced by DialContext
	},
}

var (
	reScriptStyle = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)
	reTag         = regexp.MustCompile(`(?s)<[^>]+>`)
	reBlankLines  = regexp.MustCompile(`\n[ \t]*\n[ \t\n]*`)
	htmlEntities  = strings.NewReplacer(
		"&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&nbsp;", " ",
	)
)

// htmlToText reduces HTML to readable text (best-effort; no DOM).
func htmlToText(s string) string {
	if !strings.Contains(s, "<") {
		s = strings.TrimSpace(s)
	} else {
		s = reScriptStyle.ReplaceAllString(s, " ")
		s = reTag.ReplaceAllString(s, " ")
		s = htmlEntities.Replace(s)
		s = reBlankLines.ReplaceAllString(s, "\n\n")
		s = strings.TrimSpace(s)
	}
	if len(s) > webFetchTextCap {
		s = s[:webFetchTextCap] + "\n… (truncated)"
	}
	return s
}
