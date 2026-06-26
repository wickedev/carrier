package engine

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/openai/openai-go"

	"github.com/wickedev/carrier/internal/agent"
)

func TestOpenAIDone(t *testing.T) {
	if openAIDone("tool_calls") {
		t.Error("tool_calls should mean not done")
	}
	for _, r := range []string{"stop", "length", "content_filter", ""} {
		if !openAIDone(r) {
			t.Errorf("finish_reason %q should mean done", r)
		}
	}
}

func TestOpenAIUsage(t *testing.T) {
	u := openai.CompletionUsage{
		PromptTokens:     200,
		CompletionTokens: 80,
	}
	u.PromptTokensDetails.CachedTokens = 50
	u.CompletionTokensDetails.ReasoningTokens = 30
	got := openAIUsage(u)
	want := agent.Usage{InputTokens: 200, OutputTokens: 80, CacheReadTokens: 50, ReasoningTokens: 30}
	if got != want {
		t.Fatalf("openAIUsage = %#v, want %#v", got, want)
	}
}

func TestOpenAITools(t *testing.T) {
	tools := []agent.Tool{{
		Name:        "search",
		Description: "search the web",
		Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
	}}
	got := openAITools(tools)
	if len(got) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(got))
	}
	if got[0].Function.Name != "search" {
		t.Errorf("name = %q", got[0].Function.Name)
	}
	if got[0].Function.Description.Value != "search the web" {
		t.Errorf("description = %q", got[0].Function.Description.Value)
	}
	if got[0].Function.Parameters == nil {
		t.Error("expected parameters carried through")
	}
	if openAITools(nil) != nil {
		t.Error("expected nil for no tools")
	}
	// A provider-hosted native tool is dropped (Chat Completions can't host it).
	dropped := openAITools([]agent.Tool{
		{Name: "web_search", Native: "web_search"},
		{Name: "search", Schema: map[string]any{"type": "object"}},
	})
	if len(dropped) != 1 || dropped[0].Function.Name != "search" {
		t.Errorf("expected only the function tool, got %#v", dropped)
	}
}

func TestOpenAIMessages(t *testing.T) {
	msgs := []agent.Message{
		{Role: agent.RoleUser, Text: "search cats"},
		{Role: agent.RoleAssistant, Text: "ok", ToolCalls: []agent.ToolCall{
			{ID: "call_a", Name: "search", Input: map[string]any{"q": "cats"}},
		}},
		{Role: agent.RoleTool, ToolCallID: "call_a", Text: "found 3 results"},
	}
	got := openAIMessages("be helpful", msgs)
	// system + 3 turns
	if len(got) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(got))
	}
	if got[0].OfSystem == nil {
		t.Error("expected system message first")
	}
	if got[1].OfUser == nil {
		t.Error("expected user message at index 1")
	}
	asst := got[2].OfAssistant
	if asst == nil {
		t.Fatal("expected assistant message at index 2")
	}
	if len(asst.ToolCalls) != 1 {
		t.Fatalf("expected 1 tool call, got %d", len(asst.ToolCalls))
	}
	if asst.ToolCalls[0].ID != "call_a" || asst.ToolCalls[0].Function.Name != "search" {
		t.Errorf("tool call = %#v", asst.ToolCalls[0])
	}
	// arguments must be JSON string round-trippable.
	if parseToolArguments(asst.ToolCalls[0].Function.Arguments)["q"] != "cats" {
		t.Errorf("arguments = %q", asst.ToolCalls[0].Function.Arguments)
	}
	if got[3].OfTool == nil {
		t.Error("expected tool message at index 3")
	}
}

func TestOpenAIMessages_NoSystem(t *testing.T) {
	got := openAIMessages("", []agent.Message{{Role: agent.RoleUser, Text: "hi"}})
	if len(got) != 1 {
		t.Fatalf("expected 1 message (no system), got %d", len(got))
	}
	if got[0].OfUser == nil {
		t.Error("expected user message")
	}
}

func TestClassifyOpenAIError_StatusCodes(t *testing.T) {
	cases := []struct {
		status int
		want   agent.ErrorClass
	}{
		{http.StatusTooManyRequests, agent.ErrRateLimited},
		{http.StatusRequestEntityTooLarge, agent.ErrContextOverflow},
		{http.StatusForbidden, agent.ErrQuotaExceeded},
		{http.StatusInternalServerError, agent.ErrRetryable},
		{http.StatusUnauthorized, agent.ErrFatal},
	}
	for _, c := range cases {
		err := classifyOpenAIError(&openai.Error{StatusCode: c.status})
		ee, ok := err.(*agent.EngineError)
		if !ok {
			t.Fatalf("status %d: expected *agent.EngineError, got %T", c.status, err)
		}
		if ee.Class != c.want {
			t.Errorf("status %d: class = %v, want %v", c.status, ee.Class, c.want)
		}
	}
}

func TestClassifyOpenAIError_NonAPI(t *testing.T) {
	err := classifyOpenAIError(context.DeadlineExceeded)
	ee, ok := err.(*agent.EngineError)
	if !ok {
		t.Fatalf("expected *agent.EngineError, got %T", err)
	}
	if ee.Class != agent.ErrRetryable {
		t.Errorf("class = %v, want retryable", ee.Class)
	}
}

// TestOpenAIRunStep_Live exercises the full streaming + accumulation path;
// skipped when OPENAI_API_KEY is unset so CI without keys stays green.
func TestOpenAIRunStep_Live(t *testing.T) {
	if os.Getenv("OPENAI_API_KEY") == "" {
		t.Skip("OPENAI_API_KEY not set; skipping live OpenAI test")
	}
	eng := NewOpenAIEngine()

	var sawText bool
	res, err := eng.RunStep(context.Background(), agent.StepInput{
		System:   "You are a terse assistant.",
		Messages: []agent.Message{{Role: agent.RoleUser, Text: "Say hello in one word."}},
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
		t.Errorf("expected Done=true on a plain reply")
	}
	if res.Text == "" && !sawText {
		t.Error("expected some assistant text")
	}
}
