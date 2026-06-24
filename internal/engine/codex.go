package engine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/wickedev/carrier/internal/agent"
)

// CodexEngine adapts the ChatGPT "Codex" backend (the Responses API served at
// chatgpt.com/backend-api/codex) to the Engine contract, authenticated with a
// ChatGPT SUBSCRIPTION OAuth token rather than an API key (BYOS).
//
// LOCAL DEVELOPMENT ONLY. A subscription token is intended for the Codex/ChatGPT
// apps, shares the subscription's rate limit, and is a ToS gray area for other
// uses. It is gated in cmd/carrier: selected ONLY on an explicit CARRIER_AUTH=codex
// (never auto-enabled), and `carrier serve` refuses to start with it unless bound
// to a loopback address — so it can never serve remote/multi-tenant traffic.
// Production must use a real API key (or Bedrock/Vertex).
//
// This is a hand-rolled HTTP/SSE client, not the openai-go SDK: that SDK targets
// api.openai.com with an api key, whereas this backend is a different endpoint,
// auth scheme, and request contract (Responses API with store:false+stream:true
// forced, ChatGPT-account model slugs only).
type CodexEngine struct {
	Model   string
	BaseURL string // default https://chatgpt.com/backend-api/codex
	client  *http.Client
}

// defaultCodexModel is a ChatGPT-account-supported slug (verified). The public
// api models (gpt-5, gpt-5-codex, gpt-5.1, ...) are rejected on this backend.
const defaultCodexModel = "gpt-5.5"

const defaultCodexBaseURL = "https://chatgpt.com/backend-api/codex"

// NewCodexEngine returns a Codex (subscription) engine for local dev.
func NewCodexEngine() *CodexEngine {
	return &CodexEngine{
		Model:   defaultCodexModel,
		BaseURL: defaultCodexBaseURL,
		client:  &http.Client{},
	}
}

// Name implements Engine.
func (e *CodexEngine) Name() string { return "codex" }

// ── wire shapes (Responses API subset) ──────────────────────────────────────

type codexReq struct {
	Model        string           `json:"model"`
	Instructions string           `json:"instructions,omitempty"`
	Input        []codexInputItem `json:"input"`
	Tools        []codexTool      `json:"tools,omitempty"`
	Reasoning    *codexReasoning  `json:"reasoning,omitempty"`
	Store        bool             `json:"store"`  // backend requires false
	Stream       bool             `json:"stream"` // backend requires true
}

type codexReasoning struct {
	Effort string `json:"effort"`
}

type codexTool struct {
	Type        string         `json:"type"` // "function"
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

// codexInputItem is a message, a prior function call, or a tool result. Fields
// are set per Type; omitempty keeps each item to its valid shape.
type codexInputItem struct {
	Type    string         `json:"type"`              // message | function_call | function_call_output
	Role    string         `json:"role,omitempty"`    // for message
	Content []codexContent `json:"content,omitempty"` // for message
	CallID  string         `json:"call_id,omitempty"` // for function_call / _output
	Name    string         `json:"name,omitempty"`    // for function_call
	Args    string         `json:"arguments,omitempty"`
	Output  string         `json:"output,omitempty"` // for function_call_output
}

type codexContent struct {
	Type string `json:"type"` // input_text | output_text
	Text string `json:"text"`
}

// codexEvent is one SSE frame from the Responses stream.
type codexEvent struct {
	Type     string          `json:"type"`
	Delta    string          `json:"delta"`
	Response json.RawMessage `json:"response"`
}

type codexResponse struct {
	Output []codexOutputItem `json:"output"`
	Usage  *codexUsage       `json:"usage"`
}

type codexOutputItem struct {
	Type    string         `json:"type"` // message | function_call | reasoning
	Role    string         `json:"role"`
	Content []codexContent `json:"content"`
	CallID  string         `json:"call_id"`
	Name    string         `json:"name"`
	Args    string         `json:"arguments"`
}

type codexUsage struct {
	InputTokens        int `json:"input_tokens"`
	OutputTokens       int `json:"output_tokens"`
	InputTokensDetails struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputTokensDetails struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

// RunStep implements Engine: one model turn over the Codex Responses backend.
func (e *CodexEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	auth, err := loadCodexAuth()
	if err != nil {
		return agent.StepResult{}, &agent.EngineError{Class: agent.ErrFatal, Provider: e.Name(), Message: err.Error(), Err: err}
	}

	model := e.Model
	if in.Model != "" {
		model = in.Model
	}
	if model == "" {
		model = defaultCodexModel
	}

	body := codexReq{
		Model:        model,
		Instructions: in.System,
		Input:        codexInput(in.Messages),
		Tools:        codexTools(in.Tools),
		Store:        false, // both forced by the backend (verified)
		Stream:       true,
	}
	if eff := codexEffort(in.Effort); eff != "" {
		body.Reasoning = &codexReasoning{Effort: eff}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return agent.StepResult{}, &agent.EngineError{Class: agent.ErrFatal, Provider: e.Name(), Message: err.Error(), Err: err}
	}

	url := strings.TrimRight(e.BaseURL, "/") + "/responses"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return agent.StepResult{}, &agent.EngineError{Class: agent.ErrFatal, Provider: e.Name(), Message: err.Error(), Err: err}
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "text/event-stream")
	req.Header.Set("authorization", "Bearer "+auth.accessToken)
	if auth.accountID != "" {
		req.Header.Set("chatgpt-account-id", auth.accountID)
	}
	req.Header.Set("openai-beta", "responses=v1")

	emit := in.OnEvent
	if emit == nil {
		emit = func(agent.StreamEvent) {}
	}
	emit(agent.StreamEvent{Kind: agent.EvStepStart})

	resp, err := e.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return agent.StepResult{}, ctx.Err()
		}
		return agent.StepResult{}, &agent.EngineError{Class: agent.ErrRetryable, Provider: e.Name(), Message: err.Error(), Err: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return agent.StepResult{}, classifyCodexStatus(resp.StatusCode, string(b))
	}

	return e.consume(ctx, resp.Body, emit)
}

// consume reads the SSE stream, emits canonical events, and aggregates the final
// response into a StepResult.
func (e *CodexEngine) consume(ctx context.Context, body io.Reader, emit func(agent.StreamEvent)) (agent.StepResult, error) {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var final *codexResponse
	var streamedText strings.Builder // fallback if the completed message has no text
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var ev codexEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue // ignore malformed frame
		}
		switch ev.Type {
		case "response.output_text.delta":
			if ev.Delta != "" {
				streamedText.WriteString(ev.Delta)
				emit(agent.StreamEvent{Kind: agent.EvText, Text: ev.Delta})
			}
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			if ev.Delta != "" {
				emit(agent.StreamEvent{Kind: agent.EvReasoning, Text: ev.Delta})
			}
		case "response.function_call_arguments.delta":
			if ev.Delta != "" {
				emit(agent.StreamEvent{Kind: agent.EvToolInputDelta, Text: ev.Delta})
			}
		case "response.completed":
			var r codexResponse
			if len(ev.Response) > 0 && json.Unmarshal(ev.Response, &r) == nil {
				final = &r
			}
		case "response.failed", "error":
			return agent.StepResult{}, &agent.EngineError{Class: agent.ErrRetryable, Provider: e.Name(), Message: "codex stream error: " + payload}
		}
	}
	if err := sc.Err(); err != nil {
		if ctx.Err() != nil {
			return agent.StepResult{}, ctx.Err()
		}
		return agent.StepResult{}, &agent.EngineError{Class: agent.ErrRetryable, Provider: e.Name(), Message: err.Error(), Err: err}
	}
	if final == nil {
		return agent.StepResult{}, &agent.EngineError{Class: agent.ErrRetryable, Provider: e.Name(), Message: "codex stream ended without a completed response"}
	}

	result := agent.StepResult{}
	if final.Usage != nil {
		result.Usage = agent.Usage{
			InputTokens:     final.Usage.InputTokens,
			OutputTokens:    final.Usage.OutputTokens,
			CacheReadTokens: final.Usage.InputTokensDetails.CachedTokens,
			ReasoningTokens: final.Usage.OutputTokensDetails.ReasoningTokens,
		}
	}
	var text strings.Builder
	for _, item := range final.Output {
		switch item.Type {
		case "message":
			for _, c := range item.Content {
				if c.Type == "output_text" {
					text.WriteString(c.Text)
				}
			}
		case "function_call":
			call := agent.ToolCall{ID: item.CallID, Name: item.Name, Input: parseToolArguments(item.Args)}
			result.ToolCalls = append(result.ToolCalls, call)
			ev := call
			emit(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &ev})
		}
	}
	result.Text = text.String()
	if result.Text == "" {
		// The completed message sometimes omits the aggregated text (short
		// replies that only streamed as deltas); fall back to what we streamed.
		result.Text = streamedText.String()
	}
	result.Done = len(result.ToolCalls) == 0

	emit(agent.StreamEvent{Kind: agent.EvUsage, Usage: &result.Usage})
	emit(agent.StreamEvent{Kind: agent.EvStepFinish, Usage: &result.Usage})
	return result, nil
}

// codexInput converts canonical turns into Responses-API input items: user/
// assistant messages, prior assistant tool calls (function_call), and tool
// results (function_call_output). Pure: no network.
func codexInput(msgs []agent.Message) []codexInputItem {
	out := make([]codexInputItem, 0, len(msgs))
	for _, m := range msgs {
		switch m.Role {
		case agent.RoleUser:
			out = append(out, codexInputItem{Type: "message", Role: "user",
				Content: []codexContent{{Type: "input_text", Text: m.Text}}})
		case agent.RoleAssistant:
			if m.Text != "" {
				out = append(out, codexInputItem{Type: "message", Role: "assistant",
					Content: []codexContent{{Type: "output_text", Text: m.Text}}})
			}
			for _, tc := range m.ToolCalls {
				out = append(out, codexInputItem{Type: "function_call",
					CallID: tc.ID, Name: tc.Name, Args: encodeToolArguments(tc.Input)})
			}
		case agent.RoleTool:
			out = append(out, codexInputItem{Type: "function_call_output",
				CallID: m.ToolCallID, Output: m.Text})
		}
	}
	return out
}

// codexTools converts canonical tool defs into Responses-API function tools
// (flat shape, not nested under "function"). Pure.
func codexTools(tools []agent.Tool) []codexTool {
	if len(tools) == 0 {
		return nil
	}
	out := make([]codexTool, 0, len(tools))
	for _, t := range tools {
		out = append(out, codexTool{Type: "function", Name: t.Name, Description: t.Description, Parameters: t.Schema})
	}
	return out
}

// codexEffort maps a configured effort onto reasoning.effort (low|medium|high),
// clamping the Anthropic-only xhigh/max to high. Empty/unknown → "" (omitted).
func codexEffort(effort string) string {
	switch effort {
	case "low":
		return "low"
	case "medium":
		return "medium"
	case "high", "xhigh", "max":
		return "high"
	default:
		return ""
	}
}

// classifyCodexStatus maps a non-200 HTTP status into a typed EngineError.
func classifyCodexStatus(status int, body string) error {
	ee := &agent.EngineError{Provider: "codex", Message: fmt.Sprintf("codex http %d: %s", status, strings.TrimSpace(body))}
	switch {
	case status == http.StatusTooManyRequests:
		if containsAny(body, "insufficient_quota", "exceeded", "usage_limit") {
			ee.Class = agent.ErrQuotaExceeded
		} else {
			ee.Class = agent.ErrRateLimited
		}
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		// A subscription token that the backend rejects is non-recoverable here.
		ee.Class = agent.ErrFatal
	case status == http.StatusRequestEntityTooLarge:
		ee.Class = agent.ErrContextOverflow
	case status >= 500:
		ee.Class = agent.ErrRetryable
	default:
		ee.Class = agent.ErrFatal
	}
	return ee
}
