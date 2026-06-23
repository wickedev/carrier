package plugin

import (
	"context"
	"errors"
	"testing"

	"github.com/wickedev/carrier/internal/agent"
)

// fakeSeam is a configurable in-process Seam for fold tests.
type fakeSeam struct {
	Base
	supports map[SeamKind]bool
	before   func(BeforeStepInput) (BeforeStepPatch, error)
	tbefore  func(ToolBeforeInput) (ToolBeforeDecision, error)
	tafter   func(ToolAfterInput) (ToolAfterPatch, error)
	perm     func(PermissionInput) (PermissionDecision, error)
}

func (f *fakeSeam) Supports(k SeamKind) bool { return f.supports[k] }
func (f *fakeSeam) BeforeStep(_ context.Context, in BeforeStepInput) (BeforeStepPatch, error) {
	return f.before(in)
}
func (f *fakeSeam) ToolBefore(_ context.Context, in ToolBeforeInput) (ToolBeforeDecision, error) {
	return f.tbefore(in)
}
func (f *fakeSeam) ToolAfter(_ context.Context, in ToolAfterInput) (ToolAfterPatch, error) {
	return f.tafter(in)
}
func (f *fakeSeam) PermissionAsk(_ context.Context, in PermissionInput) (PermissionDecision, error) {
	return f.perm(in)
}

func TestBeforeStepFold(t *testing.T) {
	s1 := &fakeSeam{
		Base:     Base{PluginName: "a"},
		supports: map[SeamKind]bool{SeamBeforeStep: true},
		before: func(BeforeStepInput) (BeforeStepPatch, error) {
			return BeforeStepPatch{SystemAppend: "rule A", Model: "m1", ToolsDeny: []string{"bash"}}, nil
		},
	}
	s2 := &fakeSeam{
		Base:     Base{PluginName: "b"},
		supports: map[SeamKind]bool{SeamBeforeStep: true},
		before: func(BeforeStepInput) (BeforeStepPatch, error) {
			return BeforeStepPatch{SystemAppend: "rule B", Effort: "high"}, nil
		},
	}
	c := NewChain(Entry{Seam: s1}, Entry{Seam: s2})
	in := &agent.StepInput{
		System: "base",
		Tools:  []agent.Tool{{Name: "bash"}, {Name: "read"}},
	}
	c.BeforeStep(context.Background(), in)

	if in.System != "base\n\nrule A\n\nrule B" {
		t.Fatalf("system fold = %q", in.System)
	}
	if in.Model != "m1" || in.Effort != "high" {
		t.Fatalf("model/effort = %q/%q", in.Model, in.Effort)
	}
	if len(in.Tools) != 1 || in.Tools[0].Name != "read" {
		t.Fatalf("tool filter = %+v", in.Tools)
	}
}

func TestToolBeforeDenyShortCircuits(t *testing.T) {
	calls := 0
	deny := &fakeSeam{
		Base:     Base{PluginName: "deny"},
		supports: map[SeamKind]bool{SeamToolBefore: true},
		tbefore: func(ToolBeforeInput) (ToolBeforeDecision, error) {
			calls++
			return ToolBeforeDecision{Decision: DecisionDeny, Reason: "no rm"}, nil
		},
	}
	after := &fakeSeam{
		Base:     Base{PluginName: "after"},
		supports: map[SeamKind]bool{SeamToolBefore: true},
		tbefore: func(ToolBeforeInput) (ToolBeforeDecision, error) {
			calls++
			return ToolBeforeDecision{Decision: DecisionAllow}, nil
		},
	}
	c := NewChain(Entry{Seam: deny}, Entry{Seam: after})
	gate := c.ToolBefore(context.Background(), "s", agent.ToolCall{ID: "1", Name: "bash"})
	if gate.Effect != DecisionDeny || gate.Reason != "no rm" {
		t.Fatalf("gate = %+v", gate)
	}
	if calls != 1 {
		t.Fatalf("deny should short-circuit, calls=%d", calls)
	}
}

func TestToolBeforeRewriteThreads(t *testing.T) {
	s1 := &fakeSeam{
		Base:     Base{PluginName: "rw"},
		supports: map[SeamKind]bool{SeamToolBefore: true},
		tbefore: func(in ToolBeforeInput) (ToolBeforeDecision, error) {
			return ToolBeforeDecision{Decision: DecisionAllow, RewrittenInput: map[string]any{"command": "ls"}}, nil
		},
	}
	s2 := &fakeSeam{
		Base:     Base{PluginName: "check"},
		supports: map[SeamKind]bool{SeamToolBefore: true},
		tbefore: func(in ToolBeforeInput) (ToolBeforeDecision, error) {
			if in.Input["command"] != "ls" {
				return ToolBeforeDecision{}, errors.New("rewrite not threaded")
			}
			return ToolBeforeDecision{Decision: DecisionAllow}, nil
		},
	}
	c := NewChain(Entry{Seam: s1}, Entry{Seam: s2})
	gate := c.ToolBefore(context.Background(), "s", agent.ToolCall{ID: "1", Name: "bash", Input: map[string]any{"command": "rm -rf /"}})
	if gate.Input["command"] != "ls" {
		t.Fatalf("threaded input = %+v", gate.Input)
	}
}

func TestToolAfterOverride(t *testing.T) {
	override := "REDACTED"
	s := &fakeSeam{
		Base:     Base{PluginName: "redact"},
		supports: map[SeamKind]bool{SeamToolAfter: true},
		tafter: func(ToolAfterInput) (ToolAfterPatch, error) {
			return ToolAfterPatch{ResultOverride: &override, ContextAppend: "note"}, nil
		},
	}
	c := NewChain(Entry{Seam: s})
	res := &agent.ToolResult{Content: "secret"}
	ctxAppend := c.ToolAfter(context.Background(), "s", agent.ToolCall{Name: "bash"}, res)
	if res.Content != "REDACTED" || ctxAppend != "note" {
		t.Fatalf("after = %q / %q", res.Content, ctxAppend)
	}
}

func TestPermissionAllowRequiresOptIn(t *testing.T) {
	mk := func(name string) *fakeSeam {
		return &fakeSeam{
			Base:     Base{PluginName: name},
			supports: map[SeamKind]bool{SeamPermissionAsk: true},
			perm: func(PermissionInput) (PermissionDecision, error) {
				return PermissionDecision{Decision: DecisionAllow}, nil
			},
		}
	}
	// Not opted in → allow downgraded to ask.
	c1 := NewChain(Entry{Seam: mk("p"), AllowPermissions: false})
	d, _, had := c1.PermissionAsk(context.Background(), PermissionInput{Action: "bash"})
	if d != DecisionAsk || !had {
		t.Fatalf("no opt-in: decision=%v had=%v (want ask/true)", d, had)
	}
	// Opted in → allow honored.
	c2 := NewChain(Entry{Seam: mk("p"), AllowPermissions: true})
	d, _, had = c2.PermissionAsk(context.Background(), PermissionInput{Action: "bash"})
	if d != DecisionAllow || !had {
		t.Fatalf("opt-in: decision=%v had=%v (want allow/true)", d, had)
	}
}

func TestPermissionDenyTerminalAndAbstain(t *testing.T) {
	denier := &fakeSeam{
		Base:     Base{PluginName: "d"},
		supports: map[SeamKind]bool{SeamPermissionAsk: true},
		perm: func(PermissionInput) (PermissionDecision, error) {
			return PermissionDecision{Decision: DecisionDeny, Reason: "blocked"}, nil
		},
	}
	c := NewChain(Entry{Seam: denier, AllowPermissions: true})
	d, reason, had := c.PermissionAsk(context.Background(), PermissionInput{Action: "bash"})
	if d != DecisionDeny || reason != "blocked" || !had {
		t.Fatalf("deny: %v/%q/%v", d, reason, had)
	}

	// No supporting seam → no opinion (caller falls through to its own policy).
	empty := NewChain()
	_, _, had = empty.PermissionAsk(context.Background(), PermissionInput{Action: "bash"})
	if had {
		t.Fatal("empty chain should have no opinion")
	}
}

func TestSeamErrorIsFailClosed(t *testing.T) {
	boom := &fakeSeam{
		Base:     Base{PluginName: "boom"},
		supports: map[SeamKind]bool{SeamPermissionAsk: true, SeamToolBefore: true},
		perm: func(PermissionInput) (PermissionDecision, error) {
			return PermissionDecision{}, errors.New("boom")
		},
		tbefore: func(ToolBeforeInput) (ToolBeforeDecision, error) {
			return ToolBeforeDecision{}, errors.New("boom")
		},
	}
	var failures int
	c := NewChain(Entry{Seam: boom, AllowPermissions: true})
	c.OnError(func(string, SeamKind, error) { failures++ })

	// Permission error → no opinion (never auto-allow).
	if _, _, had := c.PermissionAsk(context.Background(), PermissionInput{Action: "bash"}); had {
		t.Fatal("errored permission seam must not opine")
	}
	// Tool-before error → allow (no-op), not deny.
	if gate := c.ToolBefore(context.Background(), "s", agent.ToolCall{Name: "bash"}); gate.Effect != DecisionAllow {
		t.Fatalf("errored tool_before should be no-op allow, got %v", gate.Effect)
	}
	if failures != 2 {
		t.Fatalf("expected 2 audited failures, got %d", failures)
	}
}
