package engine

import (
	"context"
	"errors"
	"net/http"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/shared"

	"github.com/wickedev/carrier/internal/agent"
)

// OpenAIEngine adapts the OpenAI Chat Completions API to the Engine contract.
//
// Normalization notes (Chat Completions specifics this adapter must bridge):
//   - the system prompt is the first message (role "system"), not a separate
//     field;
//   - tools are {type:"function", function:{name, description, parameters}};
//   - the model's tool calls arrive in message.tool_calls, where
//     function.arguments is a JSON *string* that must be parsed;
//   - tool results are sent back as separate messages with role "tool" and a
//     tool_call_id;
//   - completion is signalled by finish_reason ("tool_calls" vs "stop").
//
// Chat Completions is preferred over the Responses/Agents SDK here: the latter
// embeds its own agent loop, which would fight Carrier's Flight loop.
type OpenAIEngine struct {
	Model  string
	client openai.Client
}

const defaultOpenAIModel = "gpt-5.1"

// NewOpenAIEngine returns an engine configured for a default chat model.
//
// The underlying client reads OPENAI_API_KEY (and the other standard OPENAI_*
// variables) from the environment.
func NewOpenAIEngine(opts ...option.RequestOption) *OpenAIEngine {
	return &OpenAIEngine{
		Model:  defaultOpenAIModel,
		client: openai.NewClient(opts...),
	}
}

// Name implements Engine.
func (e *OpenAIEngine) Name() string { return "openai" }

// RunStep implements Engine.
//
// It drives Chat.Completions.NewStreaming for exactly one model turn,
// accumulates chunks with the SDK's ChatCompletionAccumulator, emits canonical
// StreamEvents through in.OnEvent, and aggregates into an agent.StepResult.
func (e *OpenAIEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	model := e.Model
	if in.Model != "" {
		model = in.Model // per-session model override
	}
	if model == "" {
		model = defaultOpenAIModel
	}

	params := openai.ChatCompletionNewParams{
		Model:    shared.ChatModel(model),
		Messages: openAIMessages(in.System, in.Messages),
		Tools:    openAITools(in.Tools),
		StreamOptions: openai.ChatCompletionStreamOptionsParam{
			IncludeUsage: openai.Bool(true),
		},
	}
	if eff := openAIReasoningEffort(in.Effort); eff != "" {
		params.ReasoningEffort = eff // per-session reasoning effort (supported levels only)
	}

	emit := in.OnEvent
	if emit == nil {
		emit = func(agent.StreamEvent) {}
	}
	emit(agent.StreamEvent{Kind: agent.EvStepStart})

	stream := e.client.Chat.Completions.NewStreaming(ctx, params)
	acc := openai.ChatCompletionAccumulator{}

	for stream.Next() {
		chunk := stream.Current()
		acc.AddChunk(chunk)

		if len(chunk.Choices) > 0 {
			delta := chunk.Choices[0].Delta
			if delta.Content != "" {
				emit(agent.StreamEvent{Kind: agent.EvText, Text: delta.Content})
			}
			for _, tc := range delta.ToolCalls {
				if tc.Function.Arguments != "" {
					emit(agent.StreamEvent{Kind: agent.EvToolInputDelta, Text: tc.Function.Arguments})
				}
			}
		}
	}
	if err := stream.Err(); err != nil {
		if ctx.Err() != nil {
			return agent.StepResult{}, ctx.Err()
		}
		return agent.StepResult{}, classifyOpenAIError(err)
	}

	usage := openAIUsage(acc.Usage)
	result := agent.StepResult{Usage: usage}

	finishReason := ""
	if len(acc.Choices) > 0 {
		choice := acc.Choices[0]
		finishReason = choice.FinishReason
		msg := choice.Message

		if msg.Refusal != "" {
			return agent.StepResult{}, &agent.EngineError{
				Class:    agent.ErrRefusal,
				Provider: e.Name(),
				Message:  msg.Refusal,
			}
		}

		result.Text = msg.Content
		for _, tc := range msg.ToolCalls {
			call := agent.ToolCall{
				ID:    tc.ID,
				Name:  tc.Function.Name,
				Input: parseToolArguments(tc.Function.Arguments),
			}
			result.ToolCalls = append(result.ToolCalls, call)
			ev := call
			emit(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &ev})
		}
	}
	result.Done = openAIDone(finishReason)

	emit(agent.StreamEvent{Kind: agent.EvUsage, Usage: &usage})
	emit(agent.StreamEvent{Kind: agent.EvStepFinish, Usage: &usage})

	return result, nil
}

// openAITools converts canonical tool definitions into Chat-Completions
// function tool params. Pure: no network, unit-testable.
func openAITools(tools []agent.Tool) []openai.ChatCompletionToolParam {
	if len(tools) == 0 {
		return nil
	}
	out := make([]openai.ChatCompletionToolParam, 0, len(tools))
	for _, t := range tools {
		fn := shared.FunctionDefinitionParam{Name: t.Name}
		if t.Description != "" {
			fn.Description = openai.String(t.Description)
		}
		if t.Schema != nil {
			fn.Parameters = shared.FunctionParameters(t.Schema)
		}
		out = append(out, openai.ChatCompletionToolParam{Function: fn})
	}
	return out
}

// openAIMessages converts the system prompt + canonical conversation turns into
// chat message params: system as messages[0], assistant tool_calls echoed, and
// tool results as role:"tool" messages carrying tool_call_id. Pure: no network.
func openAIMessages(system string, msgs []agent.Message) []openai.ChatCompletionMessageParamUnion {
	out := make([]openai.ChatCompletionMessageParamUnion, 0, len(msgs)+1)
	if system != "" {
		out = append(out, openai.SystemMessage(system))
	}
	for _, m := range msgs {
		switch m.Role {
		case agent.RoleUser:
			out = append(out, openai.UserMessage(m.Text))
		case agent.RoleAssistant:
			if len(m.ToolCalls) == 0 {
				out = append(out, openai.AssistantMessage(m.Text))
				continue
			}
			assistant := openai.ChatCompletionAssistantMessageParam{}
			if m.Text != "" {
				assistant.Content.OfString = openai.String(m.Text)
			}
			for _, tc := range m.ToolCalls {
				assistant.ToolCalls = append(assistant.ToolCalls, openai.ChatCompletionMessageToolCallParam{
					ID: tc.ID,
					Function: openai.ChatCompletionMessageToolCallFunctionParam{
						Name:      tc.Name,
						Arguments: encodeToolArguments(tc.Input),
					},
				})
			}
			out = append(out, openai.ChatCompletionMessageParamUnion{OfAssistant: &assistant})
		case agent.RoleTool:
			out = append(out, openai.ToolMessage(m.Text, m.ToolCallID))
		}
	}
	return out
}

// openAIUsage normalizes provider usage into the canonical Usage. Pure.
func openAIUsage(u openai.CompletionUsage) agent.Usage {
	return agent.Usage{
		InputTokens:     int(u.PromptTokens),
		OutputTokens:    int(u.CompletionTokens),
		CacheReadTokens: int(u.PromptTokensDetails.CachedTokens),
		ReasoningTokens: int(u.CompletionTokensDetails.ReasoningTokens),
	}
}

// openAIDone maps a finish_reason to the Done flag: anything other than
// "tool_calls" means the model finished its turn. Pure.
func openAIDone(finishReason string) bool {
	return finishReason != "tool_calls"
}

// openAIReasoningEffort maps a configured effort level onto the values OpenAI's
// reasoning_effort accepts (low|medium|high). The shared config vocabulary also
// allows the Anthropic-only "xhigh"/"max"; those are clamped to "high" so a
// cross-provider effort setting never forwards a value OpenAI would reject. An
// empty or unrecognized level returns "" (the field is omitted). Pure.
func openAIReasoningEffort(effort string) shared.ReasoningEffort {
	switch effort {
	case "low":
		return shared.ReasoningEffortLow
	case "medium":
		return shared.ReasoningEffortMedium
	case "high", "xhigh", "max":
		return shared.ReasoningEffortHigh
	default:
		return ""
	}
}

// classifyOpenAIError translates an SDK/transport error into a typed,
// classified *agent.EngineError.
func classifyOpenAIError(err error) error {
	if err == nil {
		return nil
	}
	var apiErr *openai.Error
	if !errors.As(err, &apiErr) {
		return &agent.EngineError{
			Class:    agent.ErrRetryable,
			Provider: "openai",
			Message:  err.Error(),
			Err:      err,
		}
	}

	body := apiErr.RawJSON()
	ee := &agent.EngineError{
		Provider: "openai",
		Message:  apiErrorMessage(apiErr.StatusCode, body),
		Err:      err,
	}
	switch {
	case apiErr.StatusCode == http.StatusTooManyRequests:
		// OpenAI uses 429 for both rate limits and quota; distinguish by body.
		if containsAny(body, "insufficient_quota", "exceeded your current quota") {
			ee.Class = agent.ErrQuotaExceeded
		} else {
			ee.Class = agent.ErrRateLimited
			ee.RetryAfter = retryAfter(apiErr.Response)
		}
	case apiErr.StatusCode == http.StatusRequestEntityTooLarge:
		ee.Class = agent.ErrContextOverflow
	case apiErr.StatusCode == http.StatusBadRequest && isContextOverflowMessage(body):
		ee.Class = agent.ErrContextOverflow
	case apiErr.StatusCode == http.StatusForbidden:
		ee.Class = agent.ErrQuotaExceeded
	case apiErr.StatusCode >= 500:
		ee.Class = agent.ErrRetryable
	default:
		ee.Class = agent.ErrFatal
	}
	return ee
}
