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
	mu    sync.RWMutex
	tools map[string]Tool
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{tools: make(map[string]Tool)} }

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

// Visible returns the model-visible tools (Direct exposure), sorted by name.
func (r *Registry) Visible() []Tool {
	out := make([]Tool, 0)
	for _, t := range r.List() {
		if t.Exposure() == Direct {
			out = append(out, t)
		}
	}
	return out
}
