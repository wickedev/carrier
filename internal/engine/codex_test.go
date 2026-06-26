package engine

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
)

func TestCodexToolsNativeWebSearch(t *testing.T) {
	got := codexTools([]agent.Tool{
		{Name: "web_search", Native: "web_search", Schema: map[string]any{"type": "object"}},
		{Name: "get_weather", Description: "weather", Schema: map[string]any{"type": "object"}},
	})
	if len(got) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(got))
	}
	if got[0].Type != "web_search_preview" || got[0].Name != "" {
		t.Errorf("native tool = %#v, want {Type:web_search_preview, Name:\"\"}", got[0])
	}
	if got[1].Type != "function" || got[1].Name != "get_weather" {
		t.Errorf("function tool = %#v", got[1])
	}
	// The hosted tool must marshal WITHOUT a name field (a bare "" would be
	// rejected by the Responses API).
	b, err := json.Marshal(got[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "\"name\"") {
		t.Errorf("web_search tool should omit name, got %s", b)
	}
}

// writeCodexAuth writes a fake ~/.codex/auth.json with a JWT whose exp is `exp`,
// pointing CODEX_HOME at a temp dir, and returns a cleanup.
func writeCodexAuth(t *testing.T, exp time.Time) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payloadJSON, _ := json.Marshal(map[string]any{"exp": exp.Unix()})
	payload := base64.RawURLEncoding.EncodeToString(payloadJSON)
	jwt := header + "." + payload + ".sig"
	auth := map[string]any{
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"access_token":  jwt,
			"refresh_token": "refresh",
			"account_id":    "acct-123",
		},
	}
	b, _ := json.Marshal(auth)
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadCodexAuthValidAndExpired(t *testing.T) {
	writeCodexAuth(t, time.Now().Add(time.Hour))
	a, err := loadCodexAuth()
	if err != nil {
		t.Fatalf("valid token: %v", err)
	}
	if a.accountID != "acct-123" || a.accessToken == "" {
		t.Fatalf("auth = %+v", a)
	}
	if !CodexAuthAvailable() {
		t.Fatal("CodexAuthAvailable should be true for a valid token")
	}

	writeCodexAuth(t, time.Now().Add(-time.Minute))
	if _, err := loadCodexAuth(); err == nil {
		t.Fatal("expired token must error")
	}
	if CodexAuthAvailable() {
		t.Fatal("CodexAuthAvailable should be false for an expired token")
	}
}

func TestCodexInputAttachesToolImages(t *testing.T) {
	in := codexInput([]agent.Message{
		{Role: agent.RoleTool, ToolCallID: "c1", Text: "Attached pic.png",
			Images: []agent.ImageData{{MediaType: "image/png", Base64: "QUJD"}}},
	})
	// function_call_output (text) then a user message carrying the image.
	if len(in) != 2 {
		t.Fatalf("want 2 items (output + image message), got %d: %+v", len(in), in)
	}
	if in[0].Type != "function_call_output" || in[0].Output != "Attached pic.png" {
		t.Fatalf("output item wrong: %+v", in[0])
	}
	if in[1].Type != "message" || in[1].Role != "user" || len(in[1].Content) != 1 {
		t.Fatalf("image message wrong: %+v", in[1])
	}
	part := in[1].Content[0]
	if part.Type != "input_image" || part.ImageURL != "data:image/png;base64,QUJD" || part.Detail != "auto" {
		t.Fatalf("input_image part wrong: %+v", part)
	}
	if part.Text != "" {
		t.Errorf("input_image must not carry text, got %q", part.Text)
	}
}

func TestCodexInputNoImageMessageWhenNone(t *testing.T) {
	in := codexInput([]agent.Message{
		{Role: agent.RoleTool, ToolCallID: "c1", Text: "plain result"},
	})
	if len(in) != 1 || in[0].Type != "function_call_output" {
		t.Fatalf("text-only tool result must yield exactly one output item: %+v", in)
	}
}

func TestCodexInputConversion(t *testing.T) {
	in := codexInput([]agent.Message{
		{Role: agent.RoleUser, Text: "hi"},
		{Role: agent.RoleAssistant, Text: "calling", ToolCalls: []agent.ToolCall{
			{ID: "c1", Name: "bash", Input: map[string]any{"command": "ls"}},
		}},
		{Role: agent.RoleTool, ToolCallID: "c1", Text: "file.txt"},
	})
	if len(in) != 4 {
		t.Fatalf("want 4 items (user, assistant msg, function_call, output), got %d: %+v", len(in), in)
	}
	if in[0].Type != "message" || in[0].Role != "user" || in[0].Content[0].Type != "input_text" {
		t.Fatalf("user item wrong: %+v", in[0])
	}
	if in[1].Type != "message" || in[1].Role != "assistant" || in[1].Content[0].Type != "output_text" {
		t.Fatalf("assistant text item wrong: %+v", in[1])
	}
	if in[2].Type != "function_call" || in[2].CallID != "c1" || in[2].Name != "bash" || !strings.Contains(in[2].Args, "ls") {
		t.Fatalf("function_call item wrong: %+v", in[2])
	}
	if in[3].Type != "function_call_output" || in[3].CallID != "c1" || in[3].Output != "file.txt" {
		t.Fatalf("function_call_output item wrong: %+v", in[3])
	}
}

func TestCodexEffortClamp(t *testing.T) {
	cases := map[string]string{"": "", "low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high", "bogus": ""}
	for in, want := range cases {
		if got := codexEffort(in); got != want {
			t.Fatalf("codexEffort(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClassifyCodexStatus(t *testing.T) {
	mustClass := func(status int, body string, want agent.ErrorClass) {
		err := classifyCodexStatus(status, body)
		ee, ok := err.(*agent.EngineError)
		if !ok || ee.Class != want {
			t.Fatalf("status %d body %q → %v, want class %v", status, body, err, want)
		}
	}
	mustClass(429, "rate limit", agent.ErrRateLimited)
	mustClass(429, "you have exceeded your usage_limit", agent.ErrQuotaExceeded)
	mustClass(401, "bad token", agent.ErrFatal)
	mustClass(500, "oops", agent.ErrRetryable)
	mustClass(400, "bad request", agent.ErrFatal)
}

// TestCodexRunStepStub drives RunStep against a stub Responses backend so the
// SSE parsing + StepResult aggregation are exercised without the real network.
func TestCodexRunStepStub(t *testing.T) {
	writeCodexAuth(t, time.Now().Add(time.Hour))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") == "" || r.Header.Get("chatgpt-account-id") != "acct-123" {
			t.Errorf("missing auth headers: %v", r.Header)
		}
		var body codexReq
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Store || !body.Stream {
			t.Errorf("backend contract: want store=false, stream=true; got store=%v stream=%v", body.Store, body.Stream)
		}
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(200)
		// Stream two text deltas, then a completed response with usage.
		frames := []string{
			`{"type":"response.output_text.delta","delta":"he"}`,
			`{"type":"response.output_text.delta","delta":"llo"}`,
			`{"type":"response.completed","response":{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":5,"output_tokens":2,"output_tokens_details":{"reasoning_tokens":1}}}}`,
		}
		for _, f := range frames {
			w.Write([]byte("data: " + f + "\n\n"))
		}
	}))
	defer srv.Close()

	eng := NewCodexEngine()
	eng.BaseURL = srv.URL

	var text strings.Builder
	res, err := eng.RunStep(context.Background(), agent.StepInput{
		System:   "be brief",
		Messages: []agent.Message{{Role: agent.RoleUser, Text: "hi"}},
		OnEvent: func(ev agent.StreamEvent) {
			if ev.Kind == agent.EvText {
				text.WriteString(ev.Text)
			}
		},
	})
	if err != nil {
		t.Fatalf("RunStep: %v", err)
	}
	if res.Text != "hello" || !res.Done {
		t.Fatalf("result = %+v", res)
	}
	if text.String() != "hello" {
		t.Fatalf("streamed text = %q", text.String())
	}
	if res.Usage.InputTokens != 5 || res.Usage.OutputTokens != 2 || res.Usage.ReasoningTokens != 1 {
		t.Fatalf("usage = %+v", res.Usage)
	}
}

// TestCodexRunStepTextFallback covers a short reply that streams only as text
// deltas with an empty aggregated message in the completed response.
func TestCodexRunStepTextFallback(t *testing.T) {
	writeCodexAuth(t, time.Now().Add(time.Hour))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		for _, f := range []string{
			`{"type":"response.output_text.delta","delta":"o"}`,
			`{"type":"response.output_text.delta","delta":"k"}`,
			`{"type":"response.completed","response":{"output":[{"type":"message","role":"assistant","content":[]}],"usage":{"input_tokens":1,"output_tokens":1}}}`,
		} {
			w.Write([]byte("data: " + f + "\n\n"))
		}
	}))
	defer srv.Close()
	eng := NewCodexEngine()
	eng.BaseURL = srv.URL
	res, err := eng.RunStep(context.Background(), agent.StepInput{Messages: []agent.Message{{Role: agent.RoleUser, Text: "hi"}}})
	if err != nil {
		t.Fatalf("RunStep: %v", err)
	}
	if res.Text != "ok" {
		t.Fatalf("fallback text = %q, want %q", res.Text, "ok")
	}
}

// TestCodexRunStepToolCall verifies a function_call in the completed response
// becomes a StepResult tool call (Done=false).
func TestCodexRunStepToolCall(t *testing.T) {
	writeCodexAuth(t, time.Now().Add(time.Hour))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.Write([]byte("data: " + `{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"c1","name":"bash","arguments":"{\"command\":\"ls\"}"}],"usage":{"input_tokens":1,"output_tokens":1}}}` + "\n\n"))
	}))
	defer srv.Close()
	eng := NewCodexEngine()
	eng.BaseURL = srv.URL
	res, err := eng.RunStep(context.Background(), agent.StepInput{
		Messages: []agent.Message{{Role: agent.RoleUser, Text: "list files"}},
		Tools:    []agent.Tool{{Name: "bash", Description: "run", Schema: map[string]any{"type": "object"}}},
	})
	if err != nil {
		t.Fatalf("RunStep: %v", err)
	}
	if res.Done || len(res.ToolCalls) != 1 || res.ToolCalls[0].Name != "bash" || res.ToolCalls[0].Input["command"] != "ls" {
		t.Fatalf("tool call result = %+v", res)
	}
}

func TestCodexRunStepHTTPError(t *testing.T) {
	writeCodexAuth(t, time.Now().Add(time.Hour))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		w.Write([]byte(`{"detail":"rate limited"}`))
	}))
	defer srv.Close()
	eng := NewCodexEngine()
	eng.BaseURL = srv.URL
	_, err := eng.RunStep(context.Background(), agent.StepInput{Messages: []agent.Message{{Role: agent.RoleUser, Text: "hi"}}})
	ee, ok := err.(*agent.EngineError)
	if !ok || ee.Class != agent.ErrRateLimited {
		t.Fatalf("want ErrRateLimited, got %v", err)
	}
}
