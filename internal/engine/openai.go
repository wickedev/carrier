package engine

import (
	"context"
	"errors"

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
	Model string
	// client *openai.Client // TODO: wire the official OpenAI Go SDK.
}

// NewOpenAIEngine returns an engine configured for a default chat model.
func NewOpenAIEngine() *OpenAIEngine {
	return &OpenAIEngine{Model: "gpt-5.1"}
}

// Name implements Engine.
func (e *OpenAIEngine) Name() string { return "openai" }

// RunStep implements Engine.
func (e *OpenAIEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	// TODO: translate `in` into a Chat Completions request (system as
	// messages[0], tools -> function defs), parse tool_calls[].function.arguments
	// with encoding/json, and map the result back into agent.StepResult.
	return agent.StepResult{}, errors.New("openai engine: not implemented")
}
