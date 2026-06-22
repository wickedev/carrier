package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wickedev/carrier/internal/tool"
)

// fakeServer is a tiny in-process MCP server: it answers initialize, advertises
// a single "echo" tool, and echoes its arguments back on tools/call. When asked
// to call "boom" it returns a tool-level error result.
func fakeServer(req []byte) ([]byte, error) {
	var r rpcRequest
	if err := json.Unmarshal(req, &r); err != nil {
		return nil, err
	}

	// Notifications carry no ID and expect no reply.
	if r.ID == nil {
		return nil, nil
	}

	reply := func(result any) ([]byte, error) {
		raw, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		return json.Marshal(rpcResponse{JSONRPC: "2.0", ID: r.ID, Result: raw})
	}

	switch r.Method {
	case "initialize":
		return reply(initializeResult{
			ProtocolVersion: protocolVersion,
			Capabilities:    map[string]any{"tools": map[string]any{}},
			ServerInfo:      clientInfo{Name: "fake", Version: "1.0"},
		})

	case "tools/list":
		return reply(listToolsResult{Tools: []ToolDef{{
			Name:        "echo",
			Description: "echoes its arguments",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"msg": map[string]any{"type": "string"}},
			},
		}}})

	case "tools/call":
		var p callToolParams
		_ = json.Unmarshal(r.Params, &p)
		if p.Name == "boom" {
			return reply(callToolResult{
				Content: []contentItem{{Type: "text", Text: "kaboom"}},
				IsError: true,
			})
		}
		msg, _ := p.Arguments["msg"].(string)
		return reply(callToolResult{
			Content: []contentItem{{Type: "text", Text: "echo: " + msg}},
		})

	default:
		return json.Marshal(rpcResponse{
			JSONRPC: "2.0",
			ID:      r.ID,
			Error:   &rpcError{Code: -32601, Message: "method not found: " + r.Method},
		})
	}
}

func newFakeClient(t *testing.T) *Client {
	t.Helper()
	tr := NewInProcessTransport(fakeServer)
	c := NewClient(tr, ClientConfig{})
	t.Cleanup(func() { _ = c.Close() })
	if _, err := c.Initialize(context.Background()); err != nil {
		t.Fatalf("handshake failed: %v", err)
	}
	return c
}

func TestHandshakeAndListTools(t *testing.T) {
	c := newFakeClient(t)

	defs, err := c.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(defs) != 1 || defs[0].Name != "echo" {
		t.Fatalf("unexpected tools: %+v", defs)
	}
}

func TestNamespacingAndExec(t *testing.T) {
	c := newFakeClient(t)

	tools, err := c.Tools("fake")
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	got := tools[0].Name()
	if want := "mcp__fake__echo"; got != want {
		t.Fatalf("namespacing: got %q want %q", got, want)
	}

	res, err := tools[0].Exec(context.Background(), map[string]any{"msg": "hi"}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %+v", res)
	}
	if want := "echo: hi"; res.Content != want {
		t.Fatalf("content: got %q want %q", res.Content, want)
	}
}

func TestRegisterInto(t *testing.T) {
	c := newFakeClient(t)
	reg := tool.NewRegistry()
	if err := RegisterInto(reg, "fake", c); err != nil {
		t.Fatalf("RegisterInto: %v", err)
	}
	tl, ok := reg.Get("mcp__fake__echo")
	if !ok {
		t.Fatalf("tool not registered under namespaced name")
	}
	if tl.Description() != "echoes its arguments" {
		t.Fatalf("description not carried: %q", tl.Description())
	}
}

func TestCallToolErrorResult(t *testing.T) {
	c := newFakeClient(t)

	// Hand-build a tool bound to the "boom" remote name to exercise the
	// server-reported tool-error -> error Result mapping.
	mt := &mcpTool{
		Base:       tool.Base{ToolName: "mcp__fake__boom"},
		client:     c,
		remoteName: "boom",
	}
	res, err := mt.Exec(context.Background(), nil, tool.ExecContext{})
	if err != nil {
		t.Fatalf("transport error not expected: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected error result, got %+v", res)
	}
	if res.Content != "kaboom" {
		t.Fatalf("error content: got %q", res.Content)
	}
}
