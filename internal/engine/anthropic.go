package engine

import (
	"context"
	"errors"

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
	// client *anthropic.Client // TODO: wire the official Anthropic Go SDK.
}

// NewAnthropicEngine returns an engine configured for the current Opus model.
func NewAnthropicEngine() *AnthropicEngine {
	return &AnthropicEngine{Model: "claude-opus-4-8", MaxTokens: 16000}
}

// Name implements Engine.
func (e *AnthropicEngine) Name() string { return "anthropic" }

// RunStep implements Engine.
func (e *AnthropicEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	// TODO: translate `in` into anthropic.MessageNewParams (system as a
	// top-level field, tools -> input_schema, messages -> content blocks),
	// stream the response, and map tool_use blocks back into agent.StepResult.
	return agent.StepResult{}, errors.New("anthropic engine: not implemented")
}
