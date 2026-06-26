package engine

import (
	"encoding/base64"
	"net/http"
	"testing"

	"google.golang.org/genai"

	"github.com/wickedev/carrier/internal/agent"
)

func TestGeminiTools(t *testing.T) {
	got := geminiTools([]agent.Tool{
		{Name: "get_weather", Description: "weather", Schema: map[string]any{"type": "object"}},
		{Name: "web_search", Native: "web_search"}, // dropped: can't mix with function calling
	})
	if len(got) != 1 || len(got[0].FunctionDeclarations) != 1 {
		t.Fatalf("expected 1 tool with 1 function decl, got %+v", got)
	}
	fn := got[0].FunctionDeclarations[0]
	if fn.Name != "get_weather" || fn.Description != "weather" {
		t.Errorf("decl = %+v", fn)
	}
	if fn.ParametersJsonSchema == nil {
		t.Error("schema should be carried as ParametersJsonSchema")
	}
	if geminiTools(nil) != nil {
		t.Error("expected nil for no tools")
	}
	// A request of only native tools yields no function declarations (nil).
	if geminiTools([]agent.Tool{{Name: "web_search", Native: "web_search"}}) != nil {
		t.Error("native-only tools should produce nil")
	}
}

func TestGeminiContentsRolesAndToolName(t *testing.T) {
	got := geminiContents([]agent.Message{
		{Role: agent.RoleUser, Text: "hi"},
		{Role: agent.RoleAssistant, Text: "calling", ToolCalls: []agent.ToolCall{
			{ID: "c1", Name: "bash", Input: map[string]any{"command": "ls"}},
		}},
		{Role: agent.RoleTool, ToolCallID: "c1", Text: "file.txt"},
	})
	if len(got) != 3 {
		t.Fatalf("expected 3 contents, got %d", len(got))
	}
	if got[0].Role != genai.RoleUser || got[0].Parts[0].Text != "hi" {
		t.Errorf("user content wrong: %+v", got[0])
	}
	if got[1].Role != genai.RoleModel || got[1].Parts[1].FunctionCall == nil {
		t.Errorf("assistant content wrong: %+v", got[1])
	}
	fr := got[2].Parts[0].FunctionResponse
	if got[2].Role != genai.RoleUser || fr == nil {
		t.Fatalf("tool content wrong: %+v", got[2])
	}
	// The tool result must resolve the function NAME of the call it answers.
	if fr.Name != "bash" || fr.ID != "c1" {
		t.Errorf("functionResponse name/id = %q/%q, want bash/c1", fr.Name, fr.ID)
	}
	if fr.Response["output"] != "file.txt" {
		t.Errorf("functionResponse output = %v", fr.Response["output"])
	}
}

func TestGeminiContentsAttachesImages(t *testing.T) {
	raw := []byte("\x89PNGfake")
	b64 := base64.StdEncoding.EncodeToString(raw)
	got := geminiContents([]agent.Message{
		{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{{ID: "c1", Name: "view_image"}}},
		{Role: agent.RoleTool, ToolCallID: "c1", Text: "Attached", Images: []agent.ImageData{
			{MediaType: "image/png", Base64: b64},
		}},
	})
	// assistant(functionCall) + tool(functionResponse) + a separate user turn
	// carrying the inline image — `function_response.parts` is unsupported.
	if len(got) != 3 {
		t.Fatalf("expected 3 contents, got %d: %+v", len(got), got)
	}
	if got[1].Parts[0].FunctionResponse == nil {
		t.Fatalf("expected a functionResponse content, got %+v", got[1])
	}
	imgContent := got[2]
	if imgContent.Role != genai.RoleUser || len(imgContent.Parts) != 1 {
		t.Fatalf("expected a user image content, got %+v", imgContent)
	}
	blob := imgContent.Parts[0].InlineData
	if blob == nil || blob.MIMEType != "image/png" || string(blob.Data) != string(raw) {
		t.Fatalf("inline image blob wrong: %+v", blob)
	}
}

func TestGeminiUsage(t *testing.T) {
	u := geminiUsage(&genai.GenerateContentResponseUsageMetadata{
		PromptTokenCount:        10,
		CandidatesTokenCount:    20,
		CachedContentTokenCount: 3,
		ThoughtsTokenCount:      5,
	})
	if u.InputTokens != 10 || u.OutputTokens != 20 || u.CacheReadTokens != 3 || u.ReasoningTokens != 5 {
		t.Fatalf("usage = %+v", u)
	}
	if (geminiUsage(nil) != agent.Usage{}) {
		t.Error("nil usage should be zero")
	}
}

func TestClassifyGeminiError(t *testing.T) {
	cases := []struct {
		code int
		want agent.ErrorClass
	}{
		{http.StatusTooManyRequests, agent.ErrRateLimited},
		{http.StatusRequestEntityTooLarge, agent.ErrContextOverflow},
		{http.StatusForbidden, agent.ErrQuotaExceeded},
		{http.StatusInternalServerError, agent.ErrRetryable},
		{http.StatusBadRequest, agent.ErrFatal},
	}
	for _, tc := range cases {
		err := classifyGeminiError(genai.APIError{Code: tc.code, Message: "x"})
		var ee *agent.EngineError
		if !asEngineError(err, &ee) || ee.Class != tc.want {
			t.Errorf("code %d → class %v, want %v", tc.code, classOf(err), tc.want)
		}
	}
	// A non-API error is retryable.
	if err := classifyGeminiError(errStr("boom")); classOf(err) != agent.ErrRetryable {
		t.Errorf("non-API error should be retryable, got %v", classOf(err))
	}
}

// small helpers for the error test
type errStr string

func (e errStr) Error() string { return string(e) }

func asEngineError(err error, target **agent.EngineError) bool {
	ee, ok := err.(*agent.EngineError)
	if ok {
		*target = ee
	}
	return ok
}

func classOf(err error) agent.ErrorClass {
	if ee, ok := err.(*agent.EngineError); ok {
		return ee.Class
	}
	return agent.ErrorClass(-1)
}
