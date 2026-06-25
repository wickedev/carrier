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
	client := &http.Client{
		Timeout: webFetchTimeout,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			return guardPublicHost(r.URL.Hostname())
		},
	}
	resp, err := client.Do(req)
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

// guardPublicHost blocks SSRF to non-public destinations (loopback, private,
// link-local, unspecified). Every resolved IP must be public.
func guardPublicHost(host string) error {
	if host == "" {
		return fmt.Errorf("missing host")
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("cannot resolve host %q", host)
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return fmt.Errorf("refusing to fetch a private/loopback address: %s", host)
		}
	}
	return nil
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
