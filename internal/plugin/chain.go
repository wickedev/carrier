package plugin

import (
	"context"

	"github.com/wickedev/carrier/internal/agent"
)

// Entry is one seam in a Chain plus the trust it was granted. AllowPermissions
// reflects the operator's install-time opt-in: only then may this plugin's
// permission_ask "allow" be honored (otherwise it is downgraded to "ask").
type Entry struct {
	Seam             Seam
	AllowPermissions bool
}

// Chain folds an ordered set of seams into the operations the Flight loop calls.
// It owns the folding rules and the fail-closed semantics: a seam that errors is
// treated as abstaining (no-op), never as granting authority. An optional OnError
// sink observes seam failures for audit.
type Chain struct {
	entries []Entry
	onError func(name string, kind SeamKind, err error)
}

// NewChain builds a Chain from ordered entries. A nil/empty chain is valid and
// every method is a no-op, so the Flight loop can hold a *Chain unconditionally.
func NewChain(entries ...Entry) *Chain { return &Chain{entries: entries} }

// OnError registers an audit sink for seam failures.
func (c *Chain) OnError(fn func(name string, kind SeamKind, err error)) { c.onError = fn }

func (c *Chain) fail(name string, kind SeamKind, err error) {
	if c != nil && c.onError != nil && err != nil {
		c.onError(name, kind, err)
	}
}

// Empty reports whether the chain has no seams (lets callers skip work).
func (c *Chain) Empty() bool { return c == nil || len(c.entries) == 0 }

// BeforeStep folds every before_step seam into the StepInput in place: system
// prompts are appended (in order), model/effort are overridden last-non-empty,
// and the visible tool set is filtered (deny removes, allow-only intersects).
// The engine still clamps model/effort to provider-supported values downstream.
func (c *Chain) BeforeStep(ctx context.Context, sessionID string, in *agent.StepInput) {
	if c.Empty() {
		return
	}
	toolNames := make([]string, 0, len(in.Tools))
	for _, t := range in.Tools {
		toolNames = append(toolNames, t.Name)
	}
	for _, e := range c.entries {
		if !e.Seam.Supports(SeamBeforeStep) {
			continue
		}
		patch, err := e.Seam.BeforeStep(ctx, BeforeStepInput{
			SessionID:    sessionID,
			System:       in.System,
			MessageCount: len(in.Messages),
			Tools:        toolNames,
			Model:        in.Model,
			Effort:       in.Effort,
		})
		if err != nil {
			c.fail(e.Seam.Name(), SeamBeforeStep, err)
			continue
		}
		if patch.SystemAppend != "" {
			if in.System != "" {
				in.System += "\n\n"
			}
			in.System += patch.SystemAppend
		}
		if patch.Model != "" {
			in.Model = patch.Model
		}
		if patch.Effort != "" {
			in.Effort = patch.Effort
		}
		in.Tools = filterTools(in.Tools, patch.ToolsDeny, patch.ToolsAllowOnly)
	}
}

func filterTools(tools []agent.Tool, deny, allowOnly []string) []agent.Tool {
	if len(deny) == 0 && len(allowOnly) == 0 {
		return tools
	}
	denied := toSet(deny)
	allowed := toSet(allowOnly)
	out := tools[:0:0]
	for _, t := range tools {
		if _, d := denied[t.Name]; d {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[t.Name]; !ok {
				continue
			}
		}
		out = append(out, t)
	}
	return out
}

func toSet(xs []string) map[string]struct{} {
	if len(xs) == 0 {
		return nil
	}
	m := make(map[string]struct{}, len(xs))
	for _, x := range xs {
		m[x] = struct{}{}
	}
	return m
}

// ToolGate is the folded outcome of the tool_before seams.
type ToolGate struct {
	// Effect is the strongest decision across seams: a single Deny is terminal;
	// otherwise Ask if any seam asked, else Allow.
	Effect Decision
	Reason string
	// Input is the (possibly rewritten) tool input threaded through the seams.
	Input map[string]any
	// ContextAppend accumulates any context the seams want injected.
	ContextAppend string
}

// ToolBefore folds the tool_before seams for a call. A Deny short-circuits
// (terminal); rewritten input is threaded to the next seam; context accumulates.
func (c *Chain) ToolBefore(ctx context.Context, sessionID string, call agent.ToolCall) ToolGate {
	gate := ToolGate{Effect: DecisionAllow, Input: call.Input}
	if c.Empty() {
		return gate
	}
	asked := false
	for _, e := range c.entries {
		if !e.Seam.Supports(SeamToolBefore) {
			continue
		}
		d, err := e.Seam.ToolBefore(ctx, ToolBeforeInput{
			SessionID: sessionID, CallID: call.ID, Tool: call.Name, Input: gate.Input,
		})
		if err != nil {
			c.fail(e.Seam.Name(), SeamToolBefore, err)
			continue // fail-closed: a failing seam never grants nor denies
		}
		if d.RewrittenInput != nil {
			gate.Input = d.RewrittenInput
		}
		if d.ContextAppend != "" {
			gate.ContextAppend = appendCtx(gate.ContextAppend, d.ContextAppend)
		}
		switch d.Decision {
		case DecisionDeny:
			gate.Effect = DecisionDeny
			gate.Reason = d.Reason
			return gate // terminal
		case DecisionAsk:
			asked = true
			if gate.Reason == "" {
				gate.Reason = d.Reason
			}
		}
	}
	if asked {
		gate.Effect = DecisionAsk
	}
	return gate
}

// ToolAfter folds the tool_after seams, applying any result override to res in
// place and returning accumulated context to inject.
func (c *Chain) ToolAfter(ctx context.Context, sessionID string, call agent.ToolCall, res *agent.ToolResult) (contextAppend string) {
	if c.Empty() {
		return ""
	}
	for _, e := range c.entries {
		if !e.Seam.Supports(SeamToolAfter) {
			continue
		}
		patch, err := e.Seam.ToolAfter(ctx, ToolAfterInput{
			SessionID: sessionID, CallID: call.ID, Tool: call.Name, Input: call.Input,
			Result: ToolResultView{Content: res.Content, IsError: res.IsError},
		})
		if err != nil {
			c.fail(e.Seam.Name(), SeamToolAfter, err)
			continue
		}
		if patch.ResultOverride != nil {
			res.Content = *patch.ResultOverride
		}
		if patch.ContextAppend != "" {
			contextAppend = appendCtx(contextAppend, patch.ContextAppend)
		}
	}
	return contextAppend
}

// PermissionAsk folds the permission_ask seams. It returns the folded decision
// and whether any seam expressed an opinion. A Deny is terminal. An "allow" is
// honored only when the contributing plugin was granted AllowPermissions;
// otherwise it is downgraded to Ask (a plugin can never silently escalate). On
// error/abstain the seam is skipped; if no seam opined, hadOpinion is false so
// the caller falls through to its own policy (never auto-allow).
func (c *Chain) PermissionAsk(ctx context.Context, in PermissionInput) (decision Decision, reason string, hadOpinion bool) {
	if c.Empty() {
		return DecisionAbstain, "", false
	}
	result := DecisionAbstain
	for _, e := range c.entries {
		if !e.Seam.Supports(SeamPermissionAsk) {
			continue
		}
		d, err := e.Seam.PermissionAsk(ctx, in)
		if err != nil {
			c.fail(e.Seam.Name(), SeamPermissionAsk, err)
			continue
		}
		switch d.Decision {
		case DecisionDeny:
			return DecisionDeny, d.Reason, true // terminal, fail-closed
		case DecisionAllow:
			if !e.AllowPermissions {
				// Not opted in → downgrade to Ask (never silently escalate).
				if result != DecisionAsk {
					result, reason = DecisionAsk, d.Reason
				}
				continue
			}
			if result == DecisionAbstain {
				result, reason = DecisionAllow, d.Reason
			}
		case DecisionAsk:
			if result != DecisionAllow {
				result, reason = DecisionAsk, d.Reason
			}
		}
	}
	return result, reason, result != DecisionAbstain
}

// SessionStart / SessionEnd fold lifecycle seams, returning accumulated context.
func (c *Chain) SessionStart(ctx context.Context, in LifecycleInput) string {
	return c.lifecycle(ctx, SeamSessionStart, in)
}
func (c *Chain) SessionEnd(ctx context.Context, in LifecycleInput) string {
	return c.lifecycle(ctx, SeamSessionEnd, in)
}

func (c *Chain) lifecycle(ctx context.Context, kind SeamKind, in LifecycleInput) (out string) {
	if c.Empty() {
		return ""
	}
	for _, e := range c.entries {
		if !e.Seam.Supports(kind) {
			continue
		}
		var (
			patch LifecyclePatch
			err   error
		)
		if kind == SeamSessionStart {
			patch, err = e.Seam.SessionStart(ctx, in)
		} else {
			patch, err = e.Seam.SessionEnd(ctx, in)
		}
		if err != nil {
			c.fail(e.Seam.Name(), kind, err)
			continue
		}
		if patch.ContextAppend != "" {
			out = appendCtx(out, patch.ContextAppend)
		}
	}
	return out
}

func appendCtx(acc, add string) string {
	if acc == "" {
		return add
	}
	return acc + "\n\n" + add
}
