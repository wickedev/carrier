// Package engine holds the provider adapters that power a Flight.
//
// An Engine takes the normalized conversation and returns the model's next
// step, hiding every vendor difference — Anthropic vs OpenAI tool-call shapes,
// system-prompt handling, stop signals. Swapping the brain of a Flight is just
// swapping its Engine; the Flight loop and Tower never change.
package engine

import (
	"context"

	"github.com/wickedev/carrier/internal/agent"
)

// Engine is the single contract every provider adapter implements.
//
// It runs exactly ONE model turn — never an internal multi-step loop. The loop
// lives in the Flight so Carrier keeps full control over tool execution,
// approval gates, logging, and cancellation.
type Engine interface {
	// Name identifies the engine for logs and metrics (e.g. "anthropic").
	Name() string

	// RunStep performs one model turn. It must honor ctx cancellation.
	RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error)
}
