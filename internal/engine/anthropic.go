package engine

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"github.com/wickedev/carrier/internal/agent"
)

// AnthropicEngine adapts the Anthropic Messages API to the Engine contract.
//
// Normalization notes (Messages API specifics this adapter must bridge):
//   - the system prompt is a top-level parameter, not a message;
//   - tools use input_schema; the model's tool calls arrive as tool_use content
//     blocks whose input is already a parsed object;
//   - tool results are sent back as tool_result blocks inside a user message;
//   - completion is signalled by stop_reason ("tool_use" vs "end_turn");
//   - model "claude-opus-4-8", max_tokens is required, adaptive thinking only,
//     no temperature/top_p, and large outputs must be streamed.
type AnthropicEngine struct {
	Model     string
	MaxTokens int
	client    anthropic.Client
}

const (
	defaultAnthropicModel     = "claude-opus-4-8"
	defaultAnthropicMaxTokens = 16000
)

// NewAnthropicEngine returns an engine configured for the current Opus model.
//
// The underlying client reads ANTHROPIC_API_KEY (and the other standard
// ANTHROPIC_* variables) from the environment.
func NewAnthropicEngine(opts ...option.RequestOption) *AnthropicEngine {
	return &AnthropicEngine{
		Model:     defaultAnthropicModel,
		MaxTokens: defaultAnthropicMaxTokens,
		client:    anthropic.NewClient(opts...),
	}
}

// Name implements Engine.
func (e *AnthropicEngine) Name() string { return "anthropic" }

// RunStep implements Engine.
//
// It drives Messages.NewStreaming for exactly one model turn, emits canonical
// StreamEvents through in.OnEvent as deltas arrive, and aggregates the result
// (via the SDK's Message.Accumulate helper) into an agent.StepResult.
func (e *AnthropicEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	model := e.Model
	if in.Model != "" {
		model = in.Model // per-session model override
	}
	if model == "" {
		model = defaultAnthropicModel
	}
	maxTokens := e.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultAnthropicMaxTokens
	}

	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(model),
		MaxTokens: int64(maxTokens),
		Messages:  anthropicMessages(in.Messages),
		Tools:     anthropicTools(in.Tools),
		Thinking: anthropic.ThinkingConfigParamUnion{
			OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{},
		},
	}
	if in.System != "" {
		params.System = []anthropic.TextBlockParam{{Text: in.System}}
	}
	if in.Effort != "" {
		// Per-session reasoning effort (low|medium|high|xhigh|max). Adaptive
		// thinking stays on; effort tunes its depth.
		params.OutputConfig = anthropic.OutputConfigParam{
			Effort: anthropic.OutputConfigEffort(in.Effort),
		}
	}

	emit := in.OnEvent
	if emit == nil {
		emit = func(agent.StreamEvent) {}
	}
	emit(agent.StreamEvent{Kind: agent.EvStepStart})

	stream := e.client.Messages.NewStreaming(ctx, params)

	acc := anthropic.Message{}
	for stream.Next() {
		event := stream.Current()
		if err := acc.Accumulate(event); err != nil {
			return agent.StepResult{}, classifyAnthropicError(err)
		}

		switch event.Type {
		case "content_block_delta":
			delta := event.Delta
			switch delta.Type {
			case "text_delta":
				if delta.Text != "" {
					emit(agent.StreamEvent{Kind: agent.EvText, Text: delta.Text})
				}
			case "thinking_delta":
				if delta.Thinking != "" {
					emit(agent.StreamEvent{Kind: agent.EvReasoning, Text: delta.Thinking})
				}
			}
		}
	}
	if err := stream.Err(); err != nil {
		if ctx.Err() != nil {
			return agent.StepResult{}, ctx.Err()
		}
		return agent.StepResult{}, classifyAnthropicError(err)
	}

	if acc.StopReason == anthropic.StopReasonRefusal {
		return agent.StepResult{}, &agent.EngineError{
			Class:    agent.ErrRefusal,
			Provider: e.Name(),
			Message:  "model declined to respond (refusal stop reason)",
		}
	}

	usage := anthropicUsage(acc.Usage)
	result := agent.StepResult{
		Done:  anthropicDone(acc.StopReason),
		Usage: usage,
	}
	for _, block := range acc.Content {
		switch block.Type {
		case "text":
			result.Text += block.Text
		case "tool_use":
			tc := agent.ToolCall{
				ID:    block.ID,
				Name:  block.Name,
				Input: decodeJSONObject(block.Input),
			}
			result.ToolCalls = append(result.ToolCalls, tc)
			call := tc
			emit(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &call})
		}
	}

	emit(agent.StreamEvent{Kind: agent.EvUsage, Usage: &usage})
	emit(agent.StreamEvent{Kind: agent.EvStepFinish, Usage: &usage})

	return result, nil
}

// anthropicTools converts canonical tool definitions into Messages-API tool
// params (name, description, input_schema). Pure: no network, unit-testable.
func anthropicTools(tools []agent.Tool) []anthropic.ToolUnionParam {
	if len(tools) == 0 {
		return nil
	}
	out := make([]anthropic.ToolUnionParam, 0, len(tools))
	for _, t := range tools {
		schema := anthropic.ToolInputSchemaParam{}
		if t.Schema != nil {
			if props, ok := t.Schema["properties"]; ok {
				schema.Properties = props
			}
			if req, ok := t.Schema["required"].([]string); ok {
				schema.Required = req
			} else if req, ok := t.Schema["required"].([]any); ok {
				schema.Required = toStringSlice(req)
			}
		}
		tool := &anthropic.ToolParam{
			Name:        t.Name,
			InputSchema: schema,
		}
		if t.Description != "" {
			tool.Description = anthropic.String(t.Description)
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: tool})
	}
	return out
}

// anthropicMessages converts canonical conversation turns into MessageParams,
// echoing assistant text + tool_use blocks and folding tool results into
// tool_result blocks on a following user turn. Pure: no network.
func anthropicMessages(msgs []agent.Message) []anthropic.MessageParam {
	out := make([]anthropic.MessageParam, 0, len(msgs))
	for _, m := range msgs {
		switch m.Role {
		case agent.RoleUser:
			out = append(out, anthropic.NewUserMessage(anthropic.NewTextBlock(m.Text)))
		case agent.RoleAssistant:
			blocks := make([]anthropic.ContentBlockParamUnion, 0, 1+len(m.ToolCalls))
			if m.Text != "" {
				blocks = append(blocks, anthropic.NewTextBlock(m.Text))
			}
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, anthropic.NewToolUseBlock(tc.ID, tc.Input, tc.Name))
			}
			if len(blocks) == 0 {
				continue
			}
			out = append(out, anthropic.NewAssistantMessage(blocks...))
		case agent.RoleTool:
			// tool_result blocks live on a user turn.
			block := anthropic.NewToolResultBlock(m.ToolCallID, m.Text, false)
			out = append(out, anthropic.NewUserMessage(block))
		}
	}
	return out
}

// anthropicUsage normalizes provider usage into the canonical Usage. Pure.
func anthropicUsage(u anthropic.Usage) agent.Usage {
	return agent.Usage{
		InputTokens:      int(u.InputTokens),
		OutputTokens:     int(u.OutputTokens),
		CacheReadTokens:  int(u.CacheReadInputTokens),
		CacheWriteTokens: int(u.CacheCreationInputTokens),
	}
}

// anthropicDone maps a stop_reason to the Done flag: any reason other than
// tool_use means the model finished its turn. Pure.
func anthropicDone(reason anthropic.StopReason) bool {
	return reason != anthropic.StopReasonToolUse
}

// classifyAnthropicError translates an SDK/transport error into a typed,
// classified *agent.EngineError. Pure aside from reading the error itself.
func classifyAnthropicError(err error) error {
	if err == nil {
		return nil
	}
	var apiErr *anthropic.Error
	if !errors.As(err, &apiErr) {
		// Non-API (transport/decoding) failures are treated as retryable.
		return &agent.EngineError{
			Class:    agent.ErrRetryable,
			Provider: "anthropic",
			Message:  err.Error(),
			Err:      err,
		}
	}

	body := apiErr.RawJSON()
	ee := &agent.EngineError{
		Provider: "anthropic",
		Message:  apiErrorMessage(apiErr.StatusCode, body),
		Err:      err,
	}
	switch {
	case apiErr.StatusCode == http.StatusTooManyRequests || apiErr.StatusCode == 529:
		// 429 rate limit, 529 overloaded.
		ee.Class = agent.ErrRateLimited
		ee.RetryAfter = retryAfter(apiErr.Response)
	case apiErr.StatusCode == http.StatusRequestEntityTooLarge:
		ee.Class = agent.ErrContextOverflow
	case apiErr.StatusCode == http.StatusPaymentRequired || apiErr.StatusCode == http.StatusForbidden:
		ee.Class = agent.ErrQuotaExceeded
	case apiErr.StatusCode >= 500:
		ee.Class = agent.ErrRetryable
	case apiErr.StatusCode == http.StatusBadRequest && isContextOverflowMessage(body):
		ee.Class = agent.ErrContextOverflow
	default:
		ee.Class = agent.ErrFatal
	}
	return ee
}

// retryAfter extracts a Retry-After header (seconds or HTTP-date) if present.
func retryAfter(resp *http.Response) time.Duration {
	if resp == nil {
		return 0
	}
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}
