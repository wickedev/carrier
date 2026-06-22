// Package flight is one agent session: a single conversation driven to
// completion by an Engine, with tool calls executed in a Bay. One Flight is one
// goroutine.
package flight

import (
	"context"
	"fmt"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/bay"
	"github.com/wickedev/carrier/internal/engine"
)

// maxSteps bounds the agentic loop so a misbehaving model cannot run forever.
const maxSteps = 50

// Flight holds everything one session needs to run.
type Flight struct {
	ID     string
	System string
	Tools  []agent.Tool

	engine engine.Engine
	bay    bay.Bay

	messages []agent.Message
}

// New builds a Flight ready to run a single task.
func New(id, system string, tools []agent.Tool, eng engine.Engine, b bay.Bay) *Flight {
	return &Flight{
		ID:     id,
		System: system,
		Tools:  tools,
		engine: eng,
		bay:    b,
	}
}

// Run drives the agent loop until the model stops requesting tools, the step
// budget is exhausted, or ctx is cancelled. It returns the final assistant text.
//
// The loop is provider-agnostic: it speaks only agent.* types. The Engine
// handles all vendor translation; the Bay handles all sandboxed execution.
func (f *Flight) Run(ctx context.Context, task string) (string, error) {
	f.messages = append(f.messages, agent.Message{Role: agent.RoleUser, Text: task})

	for step := 0; step < maxSteps; step++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}

		res, err := f.engine.RunStep(ctx, agent.StepInput{
			System:   f.System,
			Messages: f.messages,
			Tools:    f.Tools,
		})
		if err != nil {
			return "", fmt.Errorf("flight %s: step %d: %w", f.ID, step, err)
		}

		if res.Done {
			return res.Text, nil
		}

		// Record the model's tool-call turn, then run each tool in the Bay and
		// feed every result back as its own tool message.
		f.messages = append(f.messages, agent.Message{
			Role:      agent.RoleAssistant,
			ToolCalls: res.ToolCalls,
		})

		for _, call := range res.ToolCalls {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			out, err := f.bay.Exec(ctx, call.Name, call.Input)
			if err != nil {
				// Surface tool failures to the model rather than aborting; it
				// can adjust its approach on the next step.
				out = fmt.Sprintf("error: %v", err)
			}
			f.messages = append(f.messages, agent.Message{
				Role:       agent.RoleTool,
				ToolCallID: call.ID,
				Text:       out,
			})
		}
	}

	return "", fmt.Errorf("flight %s: exceeded step budget (%d)", f.ID, maxSteps)
}
