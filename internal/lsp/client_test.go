package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"testing"
	"time"
)

// mockServer is an in-process LSP server speaking the same Content-Length wire
// format, used to test the client deterministically (no external binary).
type mockServer struct {
	in  *bufio.Reader // client → server
	out io.Writer     // server → client
	// serverReq, when set, is sent to the client once after didOpen to exercise
	// the server→client request path; the reply id is captured on gotReply.
	gotReply chan int
}

// publish sends a single-diagnostic publishDiagnostics for uri.
func (s *mockServer) publish(uri, message string) {
	writeFrame(s.out, map[string]any{
		"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
		"params": map[string]any{
			"uri": uri,
			"diagnostics": []map[string]any{{
				"range":    map[string]any{"start": map[string]any{"line": 3, "character": 5}},
				"severity": SeverityError, "message": message, "source": "compiler",
			}},
		},
	})
}

func writeFrame(w io.Writer, v any) error {
	body, _ := json.Marshal(v)
	if _, err := fmt.Fprintf(w, "Content-Length: %d\r\n\r\n", len(body)); err != nil {
		return err
	}
	_, err := w.Write(body)
	return err
}

func (s *mockServer) run() {
	for {
		body, err := readFrame(s.in)
		if err != nil {
			return
		}
		var msg rpcMessage
		if json.Unmarshal(body, &msg) != nil {
			continue
		}
		switch {
		case msg.Method == "initialize":
			writeFrame(s.out, map[string]any{
				"jsonrpc": "2.0", "id": json.RawMessage(*msg.ID),
				"result": map[string]any{"capabilities": map[string]any{}},
			})
		case msg.Method == "textDocument/didOpen":
			var p struct {
				TextDocument struct {
					URI string `json:"uri"`
				} `json:"textDocument"`
			}
			json.Unmarshal(msg.Params, &p)
			// Push one error diagnostic for the opened doc.
			s.publish(p.TextDocument.URI, "undefined: Foo")
			// Also send a server→client request the client must answer.
			if s.gotReply != nil {
				writeFrame(s.out, map[string]any{
					"jsonrpc": "2.0", "id": 9001,
					"method": "client/registerCapability", "params": map[string]any{},
				})
			}
		case msg.Method == "textDocument/didChange":
			var p struct {
				TextDocument struct {
					URI string `json:"uri"`
				} `json:"textDocument"`
			}
			json.Unmarshal(msg.Params, &p)
			// A change publishes a DIFFERENT diagnostic, to prove freshness.
			s.publish(p.TextDocument.URI, "changed: Bar")
		case msg.Method == "textDocument/hover":
			writeFrame(s.out, map[string]any{
				"jsonrpc": "2.0", "id": json.RawMessage(*msg.ID),
				"result": map[string]any{"contents": map[string]any{"kind": "markdown", "value": "func Foo()"}},
			})
		case msg.ID != nil && msg.Method == "":
			// This is the client's REPLY to our server→client request.
			if s.gotReply != nil {
				if id, ok := decodeID(*msg.ID); ok {
					s.gotReply <- id
				}
			}
		}
	}
}

// newMockPair wires a client to an in-process mock server via two pipes.
func newMockPair(t *testing.T, withServerReq bool) (*Client, *mockServer) {
	t.Helper()
	cliR, srvW := io.Pipe() // server → client
	srvR, cliW := io.Pipe() // client → server
	srv := &mockServer{in: bufio.NewReader(srvR), out: srvW}
	if withServerReq {
		srv.gotReply = make(chan int, 1)
	}
	go srv.run()
	c := newClient(cliW, cliR, func() error { _ = cliW.Close(); _ = srvW.Close(); return nil })
	t.Cleanup(func() { c.Close() })
	return c, srv
}

func TestClientInitializeAndDiagnostics(t *testing.T) {
	c, _ := newMockPair(t, false)
	ctx := context.Background()
	if err := c.Initialize(ctx, "file:///root"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if err := c.DidOpen("file:///root/a.go", "go", "package main", 1); err != nil {
		t.Fatalf("DidOpen: %v", err)
	}
	diags, received := c.Diagnostics(ctx, "file:///root/a.go", 1, 2*time.Second)
	if !received || len(diags) != 1 {
		t.Fatalf("expected 1 diagnostic (received), got %+v received=%v", diags, received)
	}
	d := diags[0]
	if d.Line != 3 || d.Char != 5 || d.Severity != SeverityError || d.Message != "undefined: Foo" {
		t.Fatalf("diagnostic mismatch: %+v", d)
	}
}

func TestClientHover(t *testing.T) {
	c, _ := newMockPair(t, false)
	ctx := context.Background()
	if err := c.Initialize(ctx, "file:///root"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	got, err := c.Hover(ctx, "file:///root/a.go", 0, 0)
	if err != nil {
		t.Fatalf("Hover: %v", err)
	}
	if got != "func Foo()" {
		t.Fatalf("hover = %q, want %q", got, "func Foo()")
	}
}

func TestClientAnswersServerRequests(t *testing.T) {
	// A server→client request (e.g. registerCapability) must get a reply, or a
	// real server can stall. The mock captures the reply id.
	c, srv := newMockPair(t, true)
	ctx := context.Background()
	if err := c.Initialize(ctx, "file:///root"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if err := c.DidOpen("file:///root/a.go", "go", "x", 1); err != nil {
		t.Fatalf("DidOpen: %v", err)
	}
	select {
	case id := <-srv.gotReply:
		if id != 9001 {
			t.Fatalf("reply id = %d, want 9001", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("client never replied to the server→client request")
	}
}

func TestDiagnosticsTimeoutReturnsNil(t *testing.T) {
	c, _ := newMockPair(t, false)
	// No didOpen → no diagnostics ever published for this uri.
	d, received := c.Diagnostics(context.Background(), "file:///root/never.go", 1, 100*time.Millisecond)
	if received || d != nil {
		t.Fatalf("expected (nil, false) on timeout, got %+v received=%v", d, received)
	}
}

// A late publish for an EARLIER version must not satisfy a request for a newer
// version — otherwise re-checking a file after an edit could return diagnostics
// for the superseded text.
func TestDiagnosticsRejectsStaleVersion(t *testing.T) {
	c := &Client{diags: make(map[string]diagEntry), done: make(chan struct{})}
	uri := "file:///a.go"
	publish := func(version int, msg string) {
		c.handleDiagnostics(json.RawMessage(fmt.Sprintf(
			`{"uri":%q,"version":%d,"diagnostics":[{"range":{"start":{"line":0,"character":0}},"severity":1,"message":%q}]}`,
			uri, version, msg)))
	}
	// Only a stale v1 publish is present; a request for v2+ must NOT accept it.
	publish(1, "stale")
	if d, ok := c.Diagnostics(context.Background(), uri, 2, 80*time.Millisecond); ok {
		t.Fatalf("accepted stale v1 for minVersion 2: %+v", d)
	}
	// Once the fresh v2 publish lands, it is returned.
	publish(2, "fresh")
	d, ok := c.Diagnostics(context.Background(), uri, 2, time.Second)
	if !ok || len(d) != 1 || d[0].Message != "fresh" {
		t.Fatalf("expected fresh v2 diagnostics, got %+v ok=%v", d, ok)
	}
	// A late publish for the OLDER version must NOT evict the fresh one.
	publish(1, "stale-late")
	d, ok = c.Diagnostics(context.Background(), uri, 2, time.Second)
	if !ok || len(d) != 1 || d[0].Message != "fresh" {
		t.Fatalf("stale late v1 evicted fresh v2: %+v ok=%v", d, ok)
	}
}
