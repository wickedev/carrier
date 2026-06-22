package agent

import (
	"errors"
	"testing"
	"time"
)

func TestEngineErrorClassification(t *testing.T) {
	rl := &EngineError{Class: ErrRateLimited, Provider: "anthropic", Message: "429", RetryAfter: 2 * time.Second}
	if !rl.Retryable() {
		t.Fatal("rate-limited should be retryable")
	}
	if got := rl.Class.String(); got != "rate_limited" {
		t.Fatalf("class string = %q, want rate_limited", got)
	}
	if got := rl.Error(); got != "engine(anthropic): rate_limited: 429" {
		t.Fatalf("error string = %q", got)
	}

	wrapped := errors.New("boom")
	fatal := &EngineError{Class: ErrFatal, Err: wrapped}
	if fatal.Retryable() {
		t.Fatal("fatal should not be retryable")
	}
	if !errors.Is(fatal, wrapped) {
		t.Fatal("EngineError should unwrap to the underlying error")
	}

	overflow := &EngineError{Class: ErrContextOverflow}
	if !overflow.Retryable() {
		t.Fatal("context-overflow should be retryable (after compaction)")
	}
}

func TestStreamEventShape(t *testing.T) {
	ev := StreamEvent{Kind: EvToolCall, ToolCall: &ToolCall{ID: "t1", Name: "run"}}
	if ev.Kind != EvToolCall || ev.ToolCall == nil || ev.ToolCall.ID != "t1" {
		t.Fatalf("unexpected event: %+v", ev)
	}
	if ev.Kind.String() != "tool_call" {
		t.Fatalf("kind string = %q", ev.Kind.String())
	}
}

func TestUsageAdd(t *testing.T) {
	a := Usage{InputTokens: 10, OutputTokens: 5, CacheReadTokens: 100}
	b := Usage{InputTokens: 3, OutputTokens: 7, CacheWriteTokens: 50, ReasoningTokens: 2}
	got := a.Add(b)
	want := Usage{InputTokens: 13, OutputTokens: 12, CacheReadTokens: 100, CacheWriteTokens: 50, ReasoningTokens: 2}
	if got != want {
		t.Fatalf("Usage.Add = %+v, want %+v", got, want)
	}
}
