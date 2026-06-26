// Package tool defines Carrier's tool contract, registry, and turn-level
// dispatch. Tools carry declarative metadata (read-only, concurrency-safe,
// exposure) that drives both safe parallelism and policy decisions. All command
// execution routes through a bay.Executor — tools never call os/exec directly.
package tool

import (
	"context"
	"sort"
	"sync"

	"github.com/wickedev/carrier/internal/bay"
	"github.com/wickedev/carrier/internal/lsp"
)

// Exposure controls whether a tool is visible to the model, only discoverable
// via tool-search, dispatch-only, or hidden — so a large pool need not all enter
// context.
type Exposure int

const (
	Direct    Exposure = iota // model-visible by default
	Deferred                  // surfaced only after a tool-search round-trip
	ModelOnly                 // callable by the model but not advertised
	Hidden                    // dispatch-only; never shown to the model
)

// Result is the outcome of a tool execution, normalized for feedback.
type Result struct {
	Content string
	IsError bool
	// Images carries any image content the tool produced (e.g. view_image),
	// attached to the model's context as vision input by engines that support it.
	Images []Image
}

// Image is a base64-encoded image a tool attaches to context. MediaType is an
// IANA type such as "image/png".
type Image struct {
	MediaType string
	Base64    string
}

// Spiller offloads an oversized tool result to storage and returns a bounded
// preview to substitute into context. Optional.
type Spiller interface {
	Spill(toolCallID, full string) (preview string, err error)
}

// ExecContext carries the per-execution environment handed to a tool: the
// confined Executor it must run commands through, the working directory, and an
// optional Spiller for large results.
type ExecContext struct {
	Executor bay.Executor
	Cwd      string
	// Env are extra environment entries ("KEY=VALUE") layered onto the host
	// environment for command execution (per-session env/secrets). Empty → the
	// child inherits the host environment unchanged.
	Env            []string
	Spiller        Spiller
	MaxResultBytes int // 0 → no spill
	// Asker, when set, lets a tool put a question to the user and block for the
	// answer (the ask_user tool). Nil in contexts without a human transport (e.g.
	// sub-agents, tests) — tools must handle that.
	Asker Asker
	// Shells, when set, is the session's background-shell registry (the bash
	// run_in_background / bash_output / kill_shell tools). Nil in contexts without
	// one — those tools must handle that.
	Shells *ShellRegistry
	// LSP, when set, is the session's language-server manager (the lsp tool). Nil
	// in contexts without one — the tool must handle that.
	LSP *lsp.Manager
}

// AskRequest is a question a tool surfaces to the user. Choices, when non-empty,
// are suggested answers the UI may render as buttons.
type AskRequest struct {
	Prompt  string
	Choices []string
}

// Asker delivers a question to the user and blocks until they answer (or the
// context is cancelled / it times out).
type Asker interface {
	Ask(ctx context.Context, req AskRequest) (string, error)
}

// Tool is the uniform contract every tool implements. The predicates drive
// dispatch (parallel vs serial) and policy; they default fail-closed (see Base).
type Tool interface {
	Name() string
	Description() string
	Schema() map[string]any
	// IsReadOnly reports whether the call only observes state.
	IsReadOnly(input map[string]any) bool
	// IsConcurrencySafe reports whether the call may run in parallel with other
	// concurrency-safe calls in the same turn. Defaults false (fail-closed).
	IsConcurrencySafe(input map[string]any) bool
	Exposure() Exposure
	Exec(ctx context.Context, input map[string]any, ec ExecContext) (Result, error)
}

// Base provides fail-closed defaults a concrete tool can embed; it supplies
// every Tool method except Exec. Zero value → not read-only, not
// concurrency-safe, Direct exposure.
type Base struct {
	ToolName        string
	ToolDescription string
	ToolSchema      map[string]any
	ReadOnly        bool
	ConcurrencySafe bool
	Expose          Exposure
}

func (b Base) Name() string                          { return b.ToolName }
func (b Base) Description() string                   { return b.ToolDescription }
func (b Base) Schema() map[string]any                { return b.ToolSchema }
func (b Base) IsReadOnly(map[string]any) bool        { return b.ReadOnly }
func (b Base) IsConcurrencySafe(map[string]any) bool { return b.ConcurrencySafe }
func (b Base) Exposure() Exposure                    { return b.Expose }

// Registry holds the active tool set. Registration is first-wins (built-ins
// registered before plugins/MCP keep their name), so the model-visible list has
// a stable, cache-friendly prefix.
type Registry struct {
	mu       sync.RWMutex
	tools    map[string]Tool
	revealed map[string]bool // Deferred tools made visible this session (tool_search)
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]Tool), revealed: make(map[string]bool)}
}

// Register adds a tool unless its name is already taken (first-wins).
func (r *Registry) Register(t Tool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.tools[t.Name()]; exists {
		return
	}
	r.tools[t.Name()] = t
}

// Get returns the tool registered under name.
func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

// List returns all tools sorted by name (stable order for a cache-friendly
// prompt prefix).
func (r *Registry) List() []Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out
}

// Visible returns the model-visible tools: Direct exposure plus any Deferred
// tools revealed this session (via tool_search), sorted by name.
func (r *Registry) Visible() []Tool {
	r.mu.RLock()
	revealed := make(map[string]bool, len(r.revealed))
	for k := range r.revealed {
		revealed[k] = true
	}
	r.mu.RUnlock()
	out := make([]Tool, 0)
	for _, t := range r.List() {
		switch t.Exposure() {
		case Direct:
			out = append(out, t)
		case Deferred:
			if revealed[t.Name()] {
				out = append(out, t)
			}
		}
	}
	return out
}

// Deferred returns the Deferred tools (the discoverable pool tool_search
// searches), sorted by name.
func (r *Registry) Deferred() []Tool {
	out := make([]Tool, 0)
	for _, t := range r.List() {
		if t.Exposure() == Deferred {
			out = append(out, t)
		}
	}
	return out
}

// Reveal makes a Deferred tool model-visible for the rest of the session. It
// returns false if no Deferred tool has that name (Direct tools are already
// visible; unknown names can't be revealed).
func (r *Registry) Reveal(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tools[name]
	if !ok || t.Exposure() != Deferred {
		return false
	}
	r.revealed[name] = true
	return true
}
