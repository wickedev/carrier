package hook

import (
	"context"
	"errors"
	"testing"
)

func TestPreToolUseChainRewritesThread(t *testing.T) {
	r := NewRegistry()

	// Hook A rewrites the input.
	r.AddPreToolUse("A", LayerUser, true, func(_ context.Context, in PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{
			RewrittenInput: map[string]any{"path": "/safe/path", "by": "A"},
		}, nil
	})

	// Hook B must observe A's rewritten value.
	var bSaw map[string]any
	r.AddPreToolUse("B", LayerUser, false, func(_ context.Context, in PreToolUseInput) (PreToolUseOutcome, error) {
		bSaw = in.Input
		return PreToolUseOutcome{}, nil
	})

	out, err := r.RunPreToolUse(context.Background(), PreToolUseInput{
		ToolName: "fs_write",
		Input:    map[string]any{"path": "/original"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if bSaw["path"] != "/safe/path" || bSaw["by"] != "A" {
		t.Fatalf("hook B did not see A's rewritten input: %#v", bSaw)
	}
	if out.RewrittenInput["path"] != "/safe/path" {
		t.Fatalf("final outcome did not carry rewritten input: %#v", out.RewrittenInput)
	}
	if out.Block {
		t.Fatalf("expected no block")
	}
}

func TestPreToolUseBlockShortCircuits(t *testing.T) {
	r := NewRegistry()

	r.AddPreToolUse("guard", LayerUser, true, func(_ context.Context, _ PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{Block: true, Reason: "denied by policy", AppendContext: "audit: blocked"}, nil
	})

	laterRan := false
	r.AddPreToolUse("later", LayerUser, false, func(_ context.Context, _ PreToolUseInput) (PreToolUseOutcome, error) {
		laterRan = true
		return PreToolUseOutcome{}, nil
	})

	out, err := r.RunPreToolUse(context.Background(), PreToolUseInput{ToolName: "rm", Input: nil})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !out.Block {
		t.Fatalf("expected block")
	}
	if out.Reason != "denied by policy" {
		t.Fatalf("expected reason surfaced, got %q", out.Reason)
	}
	if laterRan {
		t.Fatalf("later hook ran after a block; chain did not short-circuit")
	}
	if out.AppendContext != "audit: blocked" {
		t.Fatalf("expected accumulated context up to block, got %q", out.AppendContext)
	}
}

func TestPreToolUseAppendContextAccumulates(t *testing.T) {
	r := NewRegistry()

	r.AddPreToolUse("one", LayerUser, false, func(_ context.Context, _ PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{AppendContext: "ctx-one"}, nil
	})
	r.AddPreToolUse("two", LayerUser, false, func(_ context.Context, _ PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{AppendContext: "ctx-two"}, nil
	})
	r.AddPreToolUse("three-empty", LayerUser, false, func(_ context.Context, _ PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{}, nil
	})

	out, err := r.RunPreToolUse(context.Background(), PreToolUseInput{ToolName: "noop"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.AppendContext != "ctx-one\nctx-two" {
		t.Fatalf("context did not accumulate: %q", out.AppendContext)
	}
}

func TestPostToolUseAppendContextAccumulates(t *testing.T) {
	r := NewRegistry()
	r.AddPostToolUse("a", LayerUser, false, func(_ context.Context, _ PostToolUseInput) (PostToolUseOutcome, error) {
		return PostToolUseOutcome{AppendContext: "a"}, nil
	})
	r.AddPostToolUse("b", LayerUser, false, func(_ context.Context, _ PostToolUseInput) (PostToolUseOutcome, error) {
		return PostToolUseOutcome{AppendContext: "b"}, nil
	})

	out, err := r.RunPostToolUse(context.Background(), PostToolUseInput{ToolName: "t", Result: "ok"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.AppendContext != "a\nb" {
		t.Fatalf("post context did not accumulate: %q", out.AppendContext)
	}
}

func TestTrustDemotionForProjectAndPlugin(t *testing.T) {
	r := NewRegistry()

	r.AddPreToolUse("proj", LayerProject, true, func(_ context.Context, in PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{}, nil
	})
	r.AddPreToolUse("plug", LayerPlugin, true, func(_ context.Context, in PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{}, nil
	})
	r.AddPreToolUse("usr", LayerUser, true, func(_ context.Context, in PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{}, nil
	})
	r.AddPreToolUse("sess", LayerSession, true, func(_ context.Context, in PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{}, nil
	})

	hooks := r.Hooks(PreToolUse)
	got := map[string]bool{}
	for _, h := range hooks {
		got[h.Name] = h.Trusted()
	}

	if got["proj"] {
		t.Errorf("project-layer hook with Trust=true should be demoted to untrusted")
	}
	if got["plug"] {
		t.Errorf("plugin-layer hook with Trust=true should be demoted to untrusted")
	}
	if !got["usr"] {
		t.Errorf("user-layer hook should keep its trust")
	}
	if !got["sess"] {
		t.Errorf("session-layer hook should keep its trust")
	}
}

func TestPreToolUseErrorAborts(t *testing.T) {
	r := NewRegistry()
	wantErr := errors.New("boom")
	r.AddPreToolUse("bad", LayerUser, false, func(_ context.Context, _ PreToolUseInput) (PreToolUseOutcome, error) {
		return PreToolUseOutcome{}, wantErr
	})
	secondRan := false
	r.AddPreToolUse("second", LayerUser, false, func(_ context.Context, _ PreToolUseInput) (PreToolUseOutcome, error) {
		secondRan = true
		return PreToolUseOutcome{}, nil
	})

	_, err := r.RunPreToolUse(context.Background(), PreToolUseInput{ToolName: "x"})
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected wrapped error, got %v", err)
	}
	if secondRan {
		t.Fatalf("chain continued past an erroring hook")
	}
}

func TestLifecycleHooksAccumulate(t *testing.T) {
	r := NewRegistry()
	ctx := context.Background()

	r.AddSessionStart("s", LayerUser, false, func(_ context.Context, _ SessionStartInput) (SessionStartOutcome, error) {
		return SessionStartOutcome{AppendContext: "start"}, nil
	})
	r.AddSessionEnd("e", LayerUser, false, func(_ context.Context, _ SessionEndInput) (SessionEndOutcome, error) {
		return SessionEndOutcome{AppendContext: "end"}, nil
	})
	r.AddPreCompact("pc", LayerUser, false, func(_ context.Context, _ PreCompactInput) (PreCompactOutcome, error) {
		return PreCompactOutcome{AppendContext: "pre"}, nil
	})
	r.AddPostCompact("xc", LayerUser, false, func(_ context.Context, _ PostCompactInput) (PostCompactOutcome, error) {
		return PostCompactOutcome{AppendContext: "post"}, nil
	})

	if so, _ := r.RunSessionStart(ctx, SessionStartInput{SessionID: "1"}); so.AppendContext != "start" {
		t.Errorf("session start: %q", so.AppendContext)
	}
	if eo, _ := r.RunSessionEnd(ctx, SessionEndInput{SessionID: "1"}); eo.AppendContext != "end" {
		t.Errorf("session end: %q", eo.AppendContext)
	}
	if pc, _ := r.RunPreCompact(ctx, PreCompactInput{SessionID: "1"}); pc.AppendContext != "pre" {
		t.Errorf("pre compact: %q", pc.AppendContext)
	}
	if xc, _ := r.RunPostCompact(ctx, PostCompactInput{SessionID: "1"}); xc.AppendContext != "post" {
		t.Errorf("post compact: %q", xc.AppendContext)
	}
}

func TestEventKindString(t *testing.T) {
	cases := map[EventKind]string{
		PreToolUse:   "PreToolUse",
		PostToolUse:  "PostToolUse",
		SessionStart: "SessionStart",
		SessionEnd:   "SessionEnd",
		PreCompact:   "PreCompact",
		PostCompact:  "PostCompact",
	}
	for k, want := range cases {
		if k.String() != want {
			t.Errorf("EventKind(%d).String() = %q, want %q", k, k.String(), want)
		}
	}
}
