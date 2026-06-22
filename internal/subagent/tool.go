package subagent

import (
	"context"
	"fmt"

	"github.com/wickedev/carrier/internal/tool"
)

// depthKey is the context key under which sub-agent recursion depth is carried.
type depthKey struct{}

// WithDepth returns a context carrying recursion depth d. The task tool reads
// this to enforce MaxDepth and passes depth+1 down to each child, so nested
// task calls accumulate depth across the session tree.
func WithDepth(ctx context.Context, d int) context.Context {
	return context.WithValue(ctx, depthKey{}, d)
}

// depthFrom returns the recursion depth carried in ctx, or 0 if unset.
func depthFrom(ctx context.Context) int {
	if d, ok := ctx.Value(depthKey{}).(int); ok {
		return d
	}
	return 0
}

// taskTool is the model-facing "task" tool: it delegates a prompt to a child
// sub-agent via the Spawner and returns the child's summarized result.
//
// It is marked concurrency-safe so multiple task calls in a single turn fan out
// in parallel; the actual fan-out is bounded by the Spawner's semaphore, not by
// the dispatcher's parallelism.
type taskTool struct {
	tool.Base
	spawner *Spawner
}

// NewTaskTool builds the "task" sub-agent tool backed by s.
func NewTaskTool(s *Spawner) tool.Tool {
	return &taskTool{
		Base: tool.Base{
			ToolName:        "task",
			ToolDescription: "Delegate a focused unit of work to a sub-agent. The sub-agent runs the full agent loop on the given prompt and returns a summarized result. Use for independent work that can run in parallel.",
			ToolSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"prompt": map[string]any{
						"type":        "string",
						"description": "The task for the sub-agent to carry out.",
					},
					"description": map[string]any{
						"type":        "string",
						"description": "A short (3-5 word) label for the task.",
					},
				},
				"required": []any{"prompt"},
			},
			// Read-only is unknown (the child may write); leave false. Mark
			// concurrency-safe so a turn's task calls fan out in parallel.
			ConcurrencySafe: true,
			Expose:          tool.Direct,
		},
		spawner: s,
	}
}

// Exec spawns a child sub-agent for the prompt and returns its summary. Depth is
// read from ctx (WithDepth) and incremented for the child, so nested task tools
// respect MaxDepth.
func (t *taskTool) Exec(ctx context.Context, input map[string]any, _ tool.ExecContext) (tool.Result, error) {
	prompt, _ := input["prompt"].(string)
	if prompt == "" {
		return tool.Result{Content: "error: task requires a non-empty prompt", IsError: true}, nil
	}

	depth := depthFrom(ctx)
	parentID := fmt.Sprintf("task.d%d", depth)

	// Children run at depth+1, and their own context carries that depth so any
	// task tool they call in turn keeps accumulating toward MaxDepth.
	childCtx := WithDepth(ctx, depth+1)
	summary, err := t.spawner.Spawn(childCtx, parentID, prompt, depth)
	if err != nil {
		return tool.Result{Content: fmt.Sprintf("error: %v", err), IsError: true}, nil
	}
	return tool.Result{Content: summary}, nil
}
