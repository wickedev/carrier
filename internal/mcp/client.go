package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/wickedev/carrier/internal/tool"
)

// protocolVersion is the MCP protocol revision this client negotiates.
const protocolVersion = "2024-11-05"

// --- JSON-RPC 2.0 envelopes ---------------------------------------------------

// rpcRequest is an outgoing JSON-RPC request. A nil ID marks a notification.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// rpcResponse is an incoming JSON-RPC response.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// rpcError is a JSON-RPC error object.
type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message)
}

// --- MCP payload shapes -------------------------------------------------------

type initializeParams struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities"`
	ClientInfo      clientInfo     `json:"clientInfo"`
}

type clientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type initializeResult struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities"`
	ServerInfo      clientInfo     `json:"serverInfo"`
}

// ToolDef mirrors an MCP tool descriptor from tools/list.
type ToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

type listToolsResult struct {
	Tools []ToolDef `json:"tools"`
}

type callToolParams struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments,omitempty"`
}

// contentItem is one element of an MCP tool-call result's content array.
type contentItem struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type callToolResult struct {
	Content []contentItem `json:"content"`
	IsError bool          `json:"isError"`
}

// --- Client -------------------------------------------------------------------

// Client is a minimal MCP client over a single Transport. It is intended to be
// cheap to create and close; per-session scoping is the caller's concern. A
// Client is safe for sequential use; it serializes request/response exchanges
// with an internal mutex (MCP servers reply in request order over stdio).
type Client struct {
	t    Transport
	info clientInfo

	mu          sync.Mutex
	nextID      int64
	initialized bool
}

// ClientConfig configures a Client.
type ClientConfig struct {
	Name    string // client name advertised in initialize; defaults to "carrier"
	Version string // client version advertised in initialize; defaults to "0.1.0"
}

// NewClient wraps a Transport in a Client. It does not perform the handshake;
// call Initialize first.
func NewClient(t Transport, cfg ClientConfig) *Client {
	if cfg.Name == "" {
		cfg.Name = "carrier"
	}
	if cfg.Version == "" {
		cfg.Version = "0.1.0"
	}
	return &Client{t: t, info: clientInfo{Name: cfg.Name, Version: cfg.Version}}
}

// Close closes the underlying Transport.
func (c *Client) Close() error { return c.t.Close() }

// call performs one request/response exchange. It must be called with c.mu held.
func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.nextID++
	id := c.nextID

	var raw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return err
		}
		raw = b
	}
	reqBytes, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      &id,
		Method:  method,
		Params:  raw,
	})
	if err != nil {
		return err
	}
	if err := c.t.Send(reqBytes); err != nil {
		return err
	}

	// Read until we get the response with the matching ID, skipping any
	// notifications the server may interleave.
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		respBytes, err := c.t.Recv()
		if err != nil {
			return err
		}
		var resp rpcResponse
		if err := json.Unmarshal(respBytes, &resp); err != nil {
			return fmt.Errorf("mcp: decode response: %w", err)
		}
		if resp.ID == nil || *resp.ID != id {
			// Not our reply (notification or out-of-band); keep reading.
			continue
		}
		if resp.Error != nil {
			return resp.Error
		}
		if out != nil && len(resp.Result) > 0 {
			if err := json.Unmarshal(resp.Result, out); err != nil {
				return fmt.Errorf("mcp: decode result for %s: %w", method, err)
			}
		}
		return nil
	}
}

// notify sends a JSON-RPC notification (no ID, no reply). Must hold c.mu.
func (c *Client) notify(method string, params any) error {
	var raw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return err
		}
		raw = b
	}
	b, err := json.Marshal(rpcRequest{JSONRPC: "2.0", Method: method, Params: raw})
	if err != nil {
		return err
	}
	return c.t.Send(b)
}

// Initialize performs the MCP handshake: an initialize request followed by the
// notifications/initialized notification. It is idempotent.
func (c *Client) Initialize(ctx context.Context) (initializeResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var res initializeResult
	if c.initialized {
		return res, nil
	}
	params := initializeParams{
		ProtocolVersion: protocolVersion,
		Capabilities:    map[string]any{},
		ClientInfo:      c.info,
	}
	if err := c.call(ctx, "initialize", params, &res); err != nil {
		return res, err
	}
	if err := c.notify("notifications/initialized", struct{}{}); err != nil {
		return res, err
	}
	c.initialized = true
	return res, nil
}

// ListTools fetches the server's advertised tools via tools/list.
func (c *Client) ListTools(ctx context.Context) ([]ToolDef, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.initialized {
		return nil, errors.New("mcp: client not initialized")
	}
	var res listToolsResult
	if err := c.call(ctx, "tools/list", struct{}{}, &res); err != nil {
		return nil, err
	}
	return res.Tools, nil
}

// CallTool invokes a tool via tools/call. The returned result carries both the
// concatenated text content and the server-reported isError flag. A transport
// or protocol-level failure returns a non-nil error instead.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (callToolResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.initialized {
		return callToolResult{}, errors.New("mcp: client not initialized")
	}
	var res callToolResult
	err := c.call(ctx, "tools/call", callToolParams{Name: name, Arguments: args}, &res)
	return res, err
}

// joinText concatenates the text content items of a tool-call result.
func joinText(items []contentItem) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0].Text
	}
	var b []byte
	for i, it := range items {
		if i > 0 {
			b = append(b, '\n')
		}
		b = append(b, it.Text...)
	}
	return string(b)
}

// --- tool.Tool adaptation -----------------------------------------------------

// NamespaceName returns the namespaced tool name mcp__<server>__<tool>.
func NamespaceName(serverName, toolName string) string {
	return fmt.Sprintf("mcp__%s__%s", serverName, toolName)
}

// mcpTool adapts one MCP tool to the tool.Tool contract. MCP gives no
// read-only/concurrency hints, so it embeds tool.Base's fail-closed defaults.
type mcpTool struct {
	tool.Base
	client     *Client
	remoteName string // the server-side tool name (un-namespaced)
}

// Exec performs a tools/call and maps the result to a tool.Result. A
// server-reported tool error (isError) becomes an error Result rather than a Go
// error; transport/protocol failures become a Go error.
func (m *mcpTool) Exec(ctx context.Context, input map[string]any, _ tool.ExecContext) (tool.Result, error) {
	res, err := m.client.CallTool(ctx, m.remoteName, input)
	if err != nil {
		return tool.Result{Content: err.Error(), IsError: true}, err
	}
	return tool.Result{Content: joinText(res.Content), IsError: res.IsError}, nil
}

// Tools lists the server's tools and adapts each into a namespaced tool.Tool.
// The client must already be Initialized.
func (c *Client) Tools(serverName string) ([]tool.Tool, error) {
	defs, err := c.ListTools(context.Background())
	if err != nil {
		return nil, err
	}
	out := make([]tool.Tool, 0, len(defs))
	for _, d := range defs {
		out = append(out, &mcpTool{
			Base: tool.Base{
				ToolName:        NamespaceName(serverName, d.Name),
				ToolDescription: d.Description,
				ToolSchema:      d.InputSchema,
				Expose:          tool.Direct,
			},
			client:     c,
			remoteName: d.Name,
		})
	}
	return out, nil
}

// RegisterInto adapts the client's tools and registers them into reg under
// their namespaced names. Registration is first-wins (see tool.Registry).
func RegisterInto(reg *tool.Registry, serverName string, c *Client) error {
	tools, err := c.Tools(serverName)
	if err != nil {
		return err
	}
	for _, t := range tools {
		reg.Register(t)
	}
	return nil
}
