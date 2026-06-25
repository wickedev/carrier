package tool

import (
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
