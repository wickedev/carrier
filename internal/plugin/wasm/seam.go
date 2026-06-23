package wasm

import (
	"context"
	"encoding/json"

	"github.com/wickedev/carrier/internal/plugin"
)

// seamNames maps the typed SeamKind onto the guest export name.
var seamNames = map[plugin.SeamKind]string{
	plugin.SeamBeforeStep:    "before_step",
	plugin.SeamToolBefore:    "tool_before",
	plugin.SeamToolAfter:     "tool_after",
	plugin.SeamPermissionAsk: "permission_ask",
	plugin.SeamSessionStart:  "session_start",
	plugin.SeamSessionEnd:    "session_end",
}

// Seam adapts a sandboxed WASM Instance to the plugin.Seam interface: each call
// JSON-marshals the typed input, invokes the guest export, and unmarshals the
// JSON patch/decision. An invocation error (trap, timeout, denied output) is
// returned to the Chain, which applies fail-closed semantics.
type Seam struct {
	inst *Instance
}

// NewSeam wraps an instance as a plugin.Seam.
func NewSeam(inst *Instance) *Seam { return &Seam{inst: inst} }

func (s *Seam) Name() string { return s.inst.name }

func (s *Seam) Supports(k plugin.SeamKind) bool {
	name, ok := seamNames[k]
	return ok && s.inst.Supports(name)
}

func call[I any, O any](ctx context.Context, inst *Instance, kind plugin.SeamKind, in I) (O, error) {
	var out O
	raw, err := json.Marshal(in)
	if err != nil {
		return out, err
	}
	resp, err := inst.Invoke(ctx, seamNames[kind], raw)
	if err != nil {
		return out, err
	}
	if len(resp) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		return out, err
	}
	return out, nil
}

func (s *Seam) BeforeStep(ctx context.Context, in plugin.BeforeStepInput) (plugin.BeforeStepPatch, error) {
	return call[plugin.BeforeStepInput, plugin.BeforeStepPatch](ctx, s.inst, plugin.SeamBeforeStep, in)
}
func (s *Seam) ToolBefore(ctx context.Context, in plugin.ToolBeforeInput) (plugin.ToolBeforeDecision, error) {
	d, err := call[plugin.ToolBeforeInput, plugin.ToolBeforeDecision](ctx, s.inst, plugin.SeamToolBefore, in)
	if err == nil && d.Decision == "" {
		d.Decision = plugin.DecisionAbstain
	}
	return d, err
}
func (s *Seam) ToolAfter(ctx context.Context, in plugin.ToolAfterInput) (plugin.ToolAfterPatch, error) {
	return call[plugin.ToolAfterInput, plugin.ToolAfterPatch](ctx, s.inst, plugin.SeamToolAfter, in)
}
func (s *Seam) PermissionAsk(ctx context.Context, in plugin.PermissionInput) (plugin.PermissionDecision, error) {
	d, err := call[plugin.PermissionInput, plugin.PermissionDecision](ctx, s.inst, plugin.SeamPermissionAsk, in)
	if err == nil && d.Decision == "" {
		d.Decision = plugin.DecisionAbstain
	}
	return d, err
}
func (s *Seam) SessionStart(ctx context.Context, in plugin.LifecycleInput) (plugin.LifecyclePatch, error) {
	return call[plugin.LifecycleInput, plugin.LifecyclePatch](ctx, s.inst, plugin.SeamSessionStart, in)
}
func (s *Seam) SessionEnd(ctx context.Context, in plugin.LifecycleInput) (plugin.LifecyclePatch, error) {
	return call[plugin.LifecycleInput, plugin.LifecyclePatch](ctx, s.inst, plugin.SeamSessionEnd, in)
}

// Ensure Seam satisfies the interface.
var _ plugin.Seam = (*Seam)(nil)
