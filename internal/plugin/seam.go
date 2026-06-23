// Package plugin is the runtime seam host for Carrier's plugin system. A plugin
// (first-party Go middleware or a sandboxed WASM module) implements one or more
// typed seams that the Flight loop invokes to transform the model request, rewrite
// or gate tool calls, weigh in on permissions, and react to session lifecycle.
//
// The contract is return-new: a seam receives an input and returns a patch or
// decision; it never mutates host state. This file defines the seam vocabulary
// (mirroring the carrier.plugin/v1 wire contract); chain.go folds an ordered set
// of seams and defines the fail-closed semantics the Flight loop relies on.
package plugin

import "context"

// SeamKind identifies a seam in the carrier.plugin/v1 contract.
type SeamKind string

const (
	SeamBeforeStep    SeamKind = "before_step"
	SeamToolBefore    SeamKind = "tool_before"
	SeamToolAfter     SeamKind = "tool_after"
	SeamPermissionAsk SeamKind = "permission_ask"
	SeamSessionStart  SeamKind = "session_start"
	SeamSessionEnd    SeamKind = "session_end"
)

// Decision is a seam's verdict on a tool call or permission request.
type Decision string

const (
	DecisionAllow   Decision = "allow"
	DecisionDeny    Decision = "deny"
	DecisionAsk     Decision = "ask"
	DecisionAbstain Decision = "abstain" // "no opinion" — fall through to the host
)

// ── before_step ─────────────────────────────────────────────────────────────

// BeforeStepInput is the read-only view of a turn's request a plugin sees.
type BeforeStepInput struct {
	SessionID    string   `json:"session_id"`
	System       string   `json:"system"`
	MessageCount int      `json:"message_count"`
	Tools        []string `json:"tools"`
	Model        string   `json:"model"`
	Effort       string   `json:"effort"`
}

// BeforeStepPatch transforms the request. Empty fields are no-ops. History
// rewriting is intentionally not offered in v1.
type BeforeStepPatch struct {
	SystemAppend   string   `json:"system_append,omitempty"`
	Model          string   `json:"model,omitempty"`
	Effort         string   `json:"effort,omitempty"`
	ToolsDeny      []string `json:"tools_deny,omitempty"`
	ToolsAllowOnly []string `json:"tools_allow_only,omitempty"`
}

// ── tool_before / tool_after ────────────────────────────────────────────────

type ToolBeforeInput struct {
	SessionID string         `json:"session_id"`
	CallID    string         `json:"call_id"`
	Tool      string         `json:"tool"`
	Input     map[string]any `json:"input"`
}

type ToolBeforeDecision struct {
	Decision       Decision       `json:"decision"`
	Reason         string         `json:"reason,omitempty"`
	RewrittenInput map[string]any `json:"rewritten_input,omitempty"`
	ContextAppend  string         `json:"context_append,omitempty"`
}

type ToolResultView struct {
	Content string `json:"content"`
	IsError bool   `json:"is_error"`
}

type ToolAfterInput struct {
	SessionID string         `json:"session_id"`
	CallID    string         `json:"call_id"`
	Tool      string         `json:"tool"`
	Input     map[string]any `json:"input"`
	Result    ToolResultView `json:"result"`
}

type ToolAfterPatch struct {
	// ResultOverride, when non-nil, replaces the tool result content.
	ResultOverride *string `json:"result_override,omitempty"`
	ContextAppend  string  `json:"context_append,omitempty"`
}

// ── permission_ask ──────────────────────────────────────────────────────────

type PermissionInput struct {
	SessionID string `json:"session_id"`
	Action    string `json:"action"`
	Resource  string `json:"resource"`
}

type PermissionDecision struct {
	Decision Decision `json:"decision"`
	Reason   string   `json:"reason,omitempty"`
}

// ── session lifecycle ───────────────────────────────────────────────────────

type LifecycleInput struct {
	SessionID string            `json:"session_id"`
	Meta      map[string]string `json:"meta,omitempty"`
}

type LifecyclePatch struct {
	ContextAppend string `json:"context_append,omitempty"`
}

// Seam is implemented by every plugin backend (first-party Go middleware or a
// sandboxed WASM module). A plugin reports the seams it supports; the Chain skips
// unsupported seams. Implementations return a zero patch/decision to abstain.
type Seam interface {
	Name() string
	Supports(SeamKind) bool

	BeforeStep(ctx context.Context, in BeforeStepInput) (BeforeStepPatch, error)
	ToolBefore(ctx context.Context, in ToolBeforeInput) (ToolBeforeDecision, error)
	ToolAfter(ctx context.Context, in ToolAfterInput) (ToolAfterPatch, error)
	PermissionAsk(ctx context.Context, in PermissionInput) (PermissionDecision, error)
	SessionStart(ctx context.Context, in LifecycleInput) (LifecyclePatch, error)
	SessionEnd(ctx context.Context, in LifecycleInput) (LifecyclePatch, error)
}

// Base is an embeddable no-op Seam: every method abstains. Backends embed it and
// override only the seams they implement, plus Supports/Name.
type Base struct{ PluginName string }

func (b Base) Name() string           { return b.PluginName }
func (b Base) Supports(SeamKind) bool { return false }
func (Base) BeforeStep(context.Context, BeforeStepInput) (BeforeStepPatch, error) {
	return BeforeStepPatch{}, nil
}
func (Base) ToolBefore(context.Context, ToolBeforeInput) (ToolBeforeDecision, error) {
	return ToolBeforeDecision{Decision: DecisionAbstain}, nil
}
func (Base) ToolAfter(context.Context, ToolAfterInput) (ToolAfterPatch, error) {
	return ToolAfterPatch{}, nil
}
func (Base) PermissionAsk(context.Context, PermissionInput) (PermissionDecision, error) {
	return PermissionDecision{Decision: DecisionAbstain}, nil
}
func (Base) SessionStart(context.Context, LifecycleInput) (LifecyclePatch, error) {
	return LifecyclePatch{}, nil
}
func (Base) SessionEnd(context.Context, LifecycleInput) (LifecyclePatch, error) {
	return LifecyclePatch{}, nil
}
