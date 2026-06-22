package engine

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/anthropics/anthropic-sdk-go"

	"github.com/wickedev/carrier/internal/agent"
)

func TestAnthropicDone(t *testing.T) {
	cases := []struct {
		reason anthropic.StopReason
		want   bool
	}{
		{anthropic.StopReasonToolUse, false},
		{anthropic.StopReasonEndTurn, true},
		{anthropic.StopReasonMaxTokens, true},
		{anthropic.StopReasonStopSequence, true},
		{anthropic.StopReasonRefusal, true},
	}
	for _, c := range cases {
		if got := anthropicDone(c.reason); got != c.want {
			t.Errorf("anthropicDone(%q) = %v, want %v", c.reason, got, c.want)
		}
	}
}

func TestAnthropicUsage(t *testing.T) {
	u := anthropic.Usage{
		InputTokens:              100,
		OutputTokens:             50,
		CacheReadInputTokens:     20,
		CacheCreationInputTokens: 10,
	}
	got := anthropicUsage(u)
	want := agent.Usage{InputTokens: 100, OutputTokens: 50, CacheReadTokens: 20, CacheWriteTokens: 10}
	if got != want {
		t.Fatalf("anthropicUsage = %#v, want %#v", got, want)
	}
}

func TestAnthropicTools(t *testing.T) {
	tools := []agent.Tool{
		{
			Name:        "get_weather",
			Description: "Look up weather",
			Schema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"city": map[string]any{"type": "string"}},
				"required":   []any{"city"},
			},
		},
	}
	got := anthropicTools(tools)
	if len(got) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(got))
	}
	tp := got[0].OfTool
	if tp == nil {
		t.Fatal("expected OfTool to be set")
	}
	if tp.Name != "get_weather" {
		t.Errorf("name = %q", tp.Name)
	}
	if tp.Description.Value != "Look up weather" {
		t.Errorf("description = %q", tp.Description.Value)
	}
	if len(tp.InputSchema.Required) != 1 || tp.InputSchema.Required[0] != "city" {
		t.Errorf("required = %#v", tp.InputSchema.Required)
	}
	if tp.InputSchema.Properties == nil {
		t.Error("expected properties to be carried through")
	}
	if anthropicTools(nil) != nil {
		t.Error("expected nil for no tools")
	}
}

func TestAnthropicMessages(t *testing.T) {
	msgs := []agent.Message{
		{Role: agent.RoleUser, Text: "weather in Seoul?"},
		{Role: agent.RoleAssistant, Text: "let me check", ToolCalls: []agent.ToolCall{
			{ID: "call_1", Name: "get_weather", Input: map[string]any{"city": "Seoul"}},
		}},
		{Role: agent.RoleTool, ToolCallID: "call_1", Text: "sunny, 21C"},
	}
	got := anthropicMessages(msgs)
	if len(got) != 3 {
		t.Fatalf("expected 3 message params, got %d", len(got))
	}
	if got[0].Role != anthropic.MessageParamRoleUser {
		t.Errorf("msg0 role = %q", got[0].Role)
	}
	if got[1].Role != anthropic.MessageParamRoleAssistant {
		t.Errorf("msg1 role = %q", got[1].Role)
	}
	// assistant turn: one text block + one tool_use block.
	if len(got[1].Content) != 2 {
		t.Errorf("assistant content blocks = %d, want 2", len(got[1].Content))
	}
	// tool result is folded onto a user turn.
	if got[2].Role != anthropic.MessageParamRoleUser {
		t.Errorf("tool result turn role = %q, want user", got[2].Role)
	}
}

func TestAnthropicMessages_SkipsEmptyAssistant(t *testing.T) {
	got := anthropicMessages([]agent.Message{{Role: agent.RoleAssistant}})
	if len(got) != 0 {
		t.Fatalf("expected empty assistant turn to be skipped, got %d", len(got))
	}
}

func TestClassifyAnthropicError_NonAPI(t *testing.T) {
	err := classifyAnthropicError(context.DeadlineExceeded)
	ee, ok := err.(*agent.EngineError)
	if !ok {
		t.Fatalf("expected *agent.EngineError, got %T", err)
	}
	if ee.Class != agent.ErrRetryable {
		t.Errorf("class = %v, want retryable", ee.Class)
	}
}

func TestClassifyAnthropicError_StatusCodes(t *testing.T) {
	cases := []struct {
		status int
		want   agent.ErrorClass
	}{
		{http.StatusTooManyRequests, agent.ErrRateLimited},
		{529, agent.ErrRateLimited},
		{http.StatusRequestEntityTooLarge, agent.ErrContextOverflow},
		{http.StatusForbidden, agent.ErrQuotaExceeded},
		{http.StatusInternalServerError, agent.ErrRetryable},
		{http.StatusBadGateway, agent.ErrRetryable},
		{http.StatusUnauthorized, agent.ErrFatal},
		{http.StatusNotFound, agent.ErrFatal},
	}
	for _, c := range cases {
		apiErr := &anthropic.Error{StatusCode: c.status}
		err := classifyAnthropicError(apiErr)
		ee, ok := err.(*agent.EngineError)
		if !ok {
			t.Fatalf("status %d: expected *agent.EngineError, got %T", c.status, err)
		}
		if ee.Class != c.want {
			t.Errorf("status %d: class = %v, want %v", c.status, ee.Class, c.want)
		}
	}
}

func TestRetryAfter(t *testing.T) {
	resp := &http.Response{Header: http.Header{}}
	resp.Header.Set("Retry-After", "30")
	if got := retryAfter(resp); got != 30*time.Second {
		t.Errorf("retryAfter(30) = %v, want 30s", got)
	}
	if got := retryAfter(nil); got != 0 {
		t.Errorf("retryAfter(nil) = %v, want 0", got)
	}
	if got := retryAfter(&http.Response{Header: http.Header{}}); got != 0 {
		t.Errorf("retryAfter(no header) = %v, want 0", got)
	}
}

// TestAnthropicRunStep_Live exercises the full streaming path against the real
// API; skipped when ANTHROPIC_API_KEY is unset so CI without keys stays green.
func TestAnthropicRunStep_Live(t *testing.T) {
	if os.Getenv("ANTHROPIC_API_KEY") == "" {
		t.Skip("ANTHROPIC_API_KEY not set; skipping live Anthropic test")
	}
	eng := NewAnthropicEngine()
	eng.MaxTokens = 1024

	var sawText bool
	res, err := eng.RunStep(context.Background(), agent.StepInput{
		System:   "You are a terse assistant. Reply with a single word.",
		Messages: []agent.Message{{Role: agent.RoleUser, Text: "Say hello."}},
		OnEvent: func(ev agent.StreamEvent) {
			if ev.Kind == agent.EvText && ev.Text != "" {
				sawText = true
			}
		},
	})
	if err != nil {
		t.Fatalf("RunStep error: %v", err)
	}
	if !res.Done {
		t.Errorf("expected Done=true on a plain reply, got false")
	}
	if res.Text == "" && !sawText {
		t.Error("expected some assistant text")
	}
	if res.Usage.OutputTokens == 0 {
		t.Error("expected non-zero output tokens")
	}
}
