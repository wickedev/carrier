package tool

import (
	"net"
	"strings"
	"testing"
)

func TestTodoTool(t *testing.T) {
	td := NewTodo()
	if !td.IsReadOnly(nil) {
		t.Fatal("todo_write should be read-only (usable in plan mode)")
	}
	r := run(t, td, "", map[string]any{
		"todos": []any{
			map[string]any{"content": "design", "status": "completed"},
			map[string]any{"content": "build", "status": "in_progress"},
			map[string]any{"content": "test", "status": "pending"},
		},
	})
	if r.IsError {
		t.Fatalf("todo: %+v", r)
	}
	for _, want := range []string{"[x] design", "[~] build", "[ ] test"} {
		if !strings.Contains(r.Content, want) {
			t.Fatalf("todo render missing %q in %q", want, r.Content)
		}
	}
	// Replacing the list keeps only the new items (full-replace semantics).
	r = run(t, td, "", map[string]any{
		"todos": []any{map[string]any{"content": "ship", "status": "pending"}},
	})
	if strings.Contains(r.Content, "design") || !strings.Contains(r.Content, "[ ] ship") {
		t.Fatalf("todo should fully replace: %q", r.Content)
	}
}

func TestWebFetchGuards(t *testing.T) {
	wf := NewWebFetch()
	if !wf.IsReadOnly(nil) || !wf.IsConcurrencySafe(nil) {
		t.Fatal("web_fetch should be read-only + concurrency-safe")
	}
	// Non-http scheme rejected.
	r := run(t, wf, "", map[string]any{"url": "file:///etc/passwd"})
	if !r.IsError || !strings.Contains(r.Content, "http(s)") {
		t.Fatalf("non-http url should be rejected: %+v", r)
	}
	// SSRF: loopback/private hosts refused before any request.
	for _, u := range []string{"http://127.0.0.1:8080/x", "http://localhost/x", "http://169.254.169.254/latest/meta-data"} {
		r := run(t, wf, "", map[string]any{"url": u})
		if !r.IsError || !strings.Contains(r.Content, "private/loopback") {
			t.Fatalf("SSRF to %s should be refused: %+v", u, r)
		}
	}
}

func TestIsPublicIP(t *testing.T) {
	// The dial-time guard (which closes the DNS-rebinding hole) rejects any IP
	// for which isPublicIP is false.
	cases := map[string]bool{
		"8.8.8.8":         true,
		"1.1.1.1":         true,
		"2606:4700::1111": true,
		"127.0.0.1":       false, // loopback
		"::1":             false, // loopback v6
		"10.0.0.5":        false, // private
		"192.168.1.10":    false, // private
		"172.16.0.1":      false, // private
		"169.254.169.254": false, // link-local (cloud metadata)
		"0.0.0.0":         false, // unspecified
		"224.0.0.1":       false, // multicast
	}
	for s, want := range cases {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("bad test IP %q", s)
		}
		if got := isPublicIP(ip); got != want {
			t.Errorf("isPublicIP(%s) = %v, want %v", s, got, want)
		}
	}
}

func TestHTMLToText(t *testing.T) {
	in := `<html><head><style>x{}</style><script>var a=1</script></head>` +
		`<body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>`
	out := htmlToText(in)
	if strings.Contains(out, "<") || strings.Contains(out, "var a") || strings.Contains(out, "x{}") {
		t.Fatalf("tags/script/style not stripped: %q", out)
	}
	if !strings.Contains(out, "Title") || !strings.Contains(out, "Hello & welcome") {
		t.Fatalf("text/entities lost: %q", out)
	}
}
