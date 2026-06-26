// Package lsp is a minimal Language Server Protocol client: it speaks JSON-RPC
// over a server's stdio (Content-Length framing), drives the initialize/didOpen
// handshake, collects pushed diagnostics, and answers hover requests. It is the
// foundation for Carrier's `lsp` tool. Scope is intentionally small — just what
// the tool needs — not a full LSP implementation.
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Severity levels (LSP DiagnosticSeverity).
const (
	SeverityError   = 1
	SeverityWarning = 2
	SeverityInfo    = 3
	SeverityHint    = 4
)

// Diagnostic is one problem the server reported for a document.
type Diagnostic struct {
	Line     int // 0-based start line
	Char     int // 0-based start character
	Severity int
	Message  string
	Source   string
}

// Client is a JSON-RPC LSP client over one language server's stdio.
type Client struct {
	cmd   *exec.Cmd
	w     io.Writer
	wmu   sync.Mutex // serializes frame writes
	close func() error

	mu      sync.Mutex
	nextID  int
	pending map[int]chan rpcResult

	diagMu sync.Mutex
	diags  map[string]diagEntry // uri → latest published diagnostics + their version

	done   chan struct{}
	closed bool
}

type rpcResult struct {
	result json.RawMessage
	err    *rpcError
}

// diagEntry is the latest diagnostics published for a document and the document
// version they describe (0 when the server doesn't report a version).
type diagEntry struct {
	version int
	diags   []Diagnostic
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcMessage struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

// Spawn starts a language server process and returns a connected client whose
// read loop is running. Caller must Close it.
func Spawn(ctx context.Context, command string, args ...string) (*Client, error) {
	cmd := exec.Command(command, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("lsp: start %s: %w", command, err)
	}
	c := newClient(stdin, stdout, func() error {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		return nil
	})
	c.cmd = cmd
	return c, nil
}

// newClient wires a client to an arbitrary writer/reader (the subprocess pipes,
// or in-process pipes for tests) and starts the read loop.
func newClient(w io.Writer, r io.Reader, closeFn func() error) *Client {
	c := &Client{
		w:       w,
		close:   closeFn,
		pending: make(map[int]chan rpcResult),
		diags:   make(map[string]diagEntry),
		done:    make(chan struct{}),
	}
	go c.readLoop(bufio.NewReader(r))
	return c
}

// ── requests / notifications ─────────────────────────────────────────────────

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan rpcResult, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()

	if err := c.write(rpcMessage{JSONRPC: "2.0", ID: rawID(id), Method: method, Params: mustMarshal(params)}); err != nil {
		return nil, err
	}
	select {
	case res := <-ch:
		if res.err != nil {
			return nil, fmt.Errorf("lsp: %s: %s", method, res.err.Message)
		}
		return res.result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, fmt.Errorf("lsp: connection closed")
	}
}

func (c *Client) notify(method string, params any) error {
	return c.write(rpcMessage{JSONRPC: "2.0", Method: method, Params: mustMarshal(params)})
}

// write frames and sends one JSON-RPC message (Content-Length header + body).
func (c *Client) write(msg rpcMessage) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed {
		return fmt.Errorf("lsp: closed")
	}
	if _, err := fmt.Fprintf(c.w, "Content-Length: %d\r\n\r\n", len(body)); err != nil {
		return err
	}
	_, err = c.w.Write(body)
	return err
}

// ── read loop ────────────────────────────────────────────────────────────────

func (c *Client) readLoop(r *bufio.Reader) {
	defer close(c.done)
	for {
		body, err := readFrame(r)
		if err != nil {
			return // EOF / closed
		}
		var msg rpcMessage
		if json.Unmarshal(body, &msg) != nil {
			continue
		}
		switch {
		case msg.ID != nil && msg.Method == "":
			// Response to one of our requests.
			id, ok := decodeID(*msg.ID)
			if !ok {
				continue
			}
			c.mu.Lock()
			ch := c.pending[id]
			c.mu.Unlock()
			if ch != nil {
				ch <- rpcResult{result: msg.Result, err: msg.Error}
			}
		case msg.ID != nil && msg.Method != "":
			// Server→client REQUEST: must reply or the server may stall. We accept
			// nothing special, so answer every such request with a null result.
			_ = c.write(rpcMessage{JSONRPC: "2.0", ID: msg.ID, Result: json.RawMessage("null")})
		case msg.Method == "textDocument/publishDiagnostics":
			c.handleDiagnostics(msg.Params)
		}
	}
}

// readFrame reads one Content-Length-framed message body.
func readFrame(r *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break // end of headers
		}
		if v, ok := strings.CutPrefix(line, "Content-Length:"); ok {
			length, _ = strconv.Atoi(strings.TrimSpace(v))
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("lsp: missing Content-Length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}

func (c *Client) handleDiagnostics(params json.RawMessage) {
	var p struct {
		URI         string `json:"uri"`
		Version     int    `json:"version"`
		Diagnostics []struct {
			Range struct {
				Start struct {
					Line      int `json:"line"`
					Character int `json:"character"`
				} `json:"start"`
			} `json:"range"`
			Severity int    `json:"severity"`
			Message  string `json:"message"`
			Source   string `json:"source"`
		} `json:"diagnostics"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	out := make([]Diagnostic, 0, len(p.Diagnostics))
	for _, d := range p.Diagnostics {
		out = append(out, Diagnostic{
			Line:     d.Range.Start.Line,
			Char:     d.Range.Start.Character,
			Severity: d.Severity,
			Message:  d.Message,
			Source:   d.Source,
		})
	}
	c.diagMu.Lock()
	// Never let an older-version publish evict a newer one: a late publish for a
	// superseded document version can arrive after the fresh one, and overwriting
	// would lose the current diagnostics (and stall a version >= N waiter). For an
	// unversioned server every publish is version 0, so 0 >= 0 keeps latest-wins.
	if cur, ok := c.diags[p.URI]; !ok || p.Version >= cur.version {
		c.diags[p.URI] = diagEntry{version: p.Version, diags: out}
	}
	c.diagMu.Unlock()
}

// ── public API ───────────────────────────────────────────────────────────────

// Initialize performs the LSP handshake: initialize request then initialized
// notification. rootURI is the workspace root (a file:// URI).
func (c *Client) Initialize(ctx context.Context, rootURI string) error {
	params := map[string]any{
		"processId": nil,
		"rootUri":   rootURI,
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"publishDiagnostics": map[string]any{},
				"hover":              map[string]any{},
			},
		},
	}
	if _, err := c.call(ctx, "initialize", params); err != nil {
		return err
	}
	return c.notify("initialized", map[string]any{})
}

// DidOpen tells the server a document is open (triggers diagnostics).
func (c *Client) DidOpen(uri, languageID, text string, version int) error {
	return c.notify("textDocument/didOpen", map[string]any{
		"textDocument": map[string]any{
			"uri": uri, "languageId": languageID, "version": version, "text": text,
		},
	})
}

// DidChange sends the full new text of an already-open document (a server
// expects didChange, not a second didOpen, for updates).
func (c *Client) DidChange(uri string, version int, text string) error {
	return c.notify("textDocument/didChange", map[string]any{
		"textDocument":   map[string]any{"uri": uri, "version": version},
		"contentChanges": []map[string]any{{"text": text}},
	})
}

// ResetDiagnostics drops any cached diagnostics for uri so the next Diagnostics
// call waits for a FRESH publish (after a didOpen/didChange) rather than
// returning a stale set from a previous version.
func (c *Client) ResetDiagnostics(uri string) {
	c.diagMu.Lock()
	delete(c.diags, uri)
	c.diagMu.Unlock()
}

// Diagnostics waits up to wait for the server to publish diagnostics for uri at
// document version >= minVersion, and returns them. Requiring minVersion rejects
// a late publish for an EARLIER version (the server finishing analysis of a
// superseded text after we sent a change) — which would otherwise be returned as
// if fresh. received reports whether a qualifying publish arrived: false means
// the wait timed out (NOT the same as "clean file", which is received=true with
// an empty slice).
//
// Servers that don't report a version (publish version 0) can't be version-
// filtered, so version-0 publishes are accepted as best-effort; the preceding
// cache reset still avoids returning a prior tool call's result.
func (c *Client) Diagnostics(ctx context.Context, uri string, minVersion int, wait time.Duration) (diags []Diagnostic, received bool) {
	deadline := time.Now().Add(wait)
	for {
		c.diagMu.Lock()
		e, ok := c.diags[uri]
		c.diagMu.Unlock()
		if ok && (e.version == 0 || e.version >= minVersion) {
			return e.diags, true
		}
		if time.Now().After(deadline) {
			return nil, false
		}
		select {
		case <-ctx.Done():
			return nil, false
		case <-c.done:
			return nil, false
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// Hover requests hover text at a 0-based line/character. Returns "" if none.
func (c *Client) Hover(ctx context.Context, uri string, line, char int) (string, error) {
	raw, err := c.call(ctx, "textDocument/hover", map[string]any{
		"textDocument": map[string]any{"uri": uri},
		"position":     map[string]any{"line": line, "character": char},
	})
	if err != nil {
		return "", err
	}
	var hov struct {
		Contents json.RawMessage `json:"contents"`
	}
	if json.Unmarshal(raw, &hov) != nil || len(hov.Contents) == 0 {
		return "", nil
	}
	return parseHoverContents(hov.Contents), nil
}

// Close shuts the server down and releases resources.
func (c *Client) Close() error {
	c.wmu.Lock()
	already := c.closed
	c.closed = true
	c.wmu.Unlock()
	if already {
		return nil
	}
	if c.close != nil {
		return c.close()
	}
	return nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

// parseHoverContents extracts plain text from any of the LSP hover content
// shapes: a MarkupContent object, a {language,value} object, a bare string, or
// an array of those.
func parseHoverContents(raw json.RawMessage) string {
	var obj struct {
		Value string `json:"value"`
		Kind  string `json:"kind"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Value != "" {
		return obj.Value
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && s != "" {
		return s
	}
	var arr []json.RawMessage
	if json.Unmarshal(raw, &arr) == nil {
		parts := make([]string, 0, len(arr))
		for _, e := range arr {
			if p := parseHoverContents(e); p != "" {
				parts = append(parts, p)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return b
}

func rawID(id int) *json.RawMessage {
	r := json.RawMessage(strconv.Itoa(id))
	return &r
}

func decodeID(raw json.RawMessage) (int, bool) {
	var id int
	if json.Unmarshal(raw, &id) == nil {
		return id, true
	}
	return 0, false
}
