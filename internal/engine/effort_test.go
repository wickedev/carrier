package engine

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/option"
	openaiopt "github.com/openai/openai-go/option"

	"github.com/wickedev/carrier/internal/agent"
)

// captureRT records the outgoing request body, then returns a 400 so the SDK
// stops without retrying. We assert on the captured request, not the response.
type captureRT struct{ body string }

func (c *captureRT) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		c.body = string(b)
	}
	return &http.Response{
		StatusCode: http.StatusBadRequest,
		Body:       io.NopCloser(bytes.NewReader([]byte(`{"type":"error"}`))),
		Header:     make(http.Header),
		Request:    req,
	}, nil
}

func TestAnthropicSendsEffort(t *testing.T) {
	rt := &captureRT{}
	eng := NewAnthropicEngine(
		option.WithAPIKey("test"),
		option.WithHTTPClient(&http.Client{Transport: rt}),
		option.WithMaxRetries(0),
	)
	// Error is expected (400); we only care that the request carried the effort.
	_, _ = eng.RunStep(context.Background(), agent.StepInput{
		Messages: []agent.Message{{Role: agent.RoleUser, Text: "hi"}},
		Effort:   "high",
	})
	if !strings.Contains(rt.body, `"output_config"`) || !strings.Contains(rt.body, `"effort":"high"`) {
		t.Fatalf("anthropic request missing effort; body=%s", rt.body)
	}
}

func TestAnthropicOmitsEffortWhenEmpty(t *testing.T) {
	rt := &captureRT{}
	eng := NewAnthropicEngine(
		option.WithAPIKey("test"),
		option.WithHTTPClient(&http.Client{Transport: rt}),
		option.WithMaxRetries(0),
	)
	_, _ = eng.RunStep(context.Background(), agent.StepInput{
		Messages: []agent.Message{{Role: agent.RoleUser, Text: "hi"}},
	})
	if strings.Contains(rt.body, `"effort"`) {
		t.Fatalf("anthropic request should omit effort when unset; body=%s", rt.body)
	}
}

func TestOpenAISendsEffort(t *testing.T) {
	rt := &captureRT{}
	eng := NewOpenAIEngine(
		openaiopt.WithAPIKey("test"),
		openaiopt.WithHTTPClient(&http.Client{Transport: rt}),
		openaiopt.WithMaxRetries(0),
	)
	_, _ = eng.RunStep(context.Background(), agent.StepInput{
		Messages: []agent.Message{{Role: agent.RoleUser, Text: "hi"}},
		Effort:   "medium",
	})
	if !strings.Contains(rt.body, `"reasoning_effort":"medium"`) {
		t.Fatalf("openai request missing reasoning_effort; body=%s", rt.body)
	}
}

// OpenAI only supports low|medium|high; the Anthropic-only xhigh/max levels must
// be clamped to "high" rather than forwarded (which OpenAI would reject).
func TestOpenAIClampsUnsupportedEffort(t *testing.T) {
	for _, level := range []string{"xhigh", "max"} {
		rt := &captureRT{}
		eng := NewOpenAIEngine(
			openaiopt.WithAPIKey("test"),
			openaiopt.WithHTTPClient(&http.Client{Transport: rt}),
			openaiopt.WithMaxRetries(0),
		)
		_, _ = eng.RunStep(context.Background(), agent.StepInput{
			Messages: []agent.Message{{Role: agent.RoleUser, Text: "hi"}},
			Effort:   level,
		})
		if !strings.Contains(rt.body, `"reasoning_effort":"high"`) {
			t.Fatalf("effort %q should clamp to high; body=%s", level, rt.body)
		}
		if strings.Contains(rt.body, `"reasoning_effort":"`+level+`"`) {
			t.Fatalf("effort %q was forwarded unclamped; body=%s", level, rt.body)
		}
	}
}

// A pure mapping check, independent of the wire.
func TestOpenAIReasoningEffortMapping(t *testing.T) {
	cases := map[string]string{
		"":       "",
		"low":    "low",
		"medium": "medium",
		"high":   "high",
		"xhigh":  "high",
		"max":    "high",
		"bogus":  "",
	}
	for in, want := range cases {
		if got := string(openAIReasoningEffort(in)); got != want {
			t.Fatalf("openAIReasoningEffort(%q) = %q, want %q", in, got, want)
		}
	}
}
