package tool

import (
	"context"
	"fmt"
	"os"

	"github.com/wickedev/carrier/internal/bay"
)

// Bash runs a shell command in the Flight's confined Executor. It is the
// canonical example of a tool that delegates execution to a bay.Executor rather
// than touching the host directly. Fail-closed: not read-only, not
// concurrency-safe (a command may write).
type Bash struct{ Base }

// NewBash returns the bash tool.
func NewBash() *Bash {
	return &Bash{Base: Base{
		ToolName:        "bash",
		ToolDescription: "Run a shell command in the session sandbox.",
		ToolSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{
					"type":        "string",
					"description": "The shell command to run.",
				},
			},
			"required": []string{"command"},
		},
	}}
}

// Exec implements Tool.
func (b *Bash) Exec(ctx context.Context, input map[string]any, ec ExecContext) (Result, error) {
	cmd, _ := input["command"].(string)
	if cmd == "" {
		return Result{Content: "error: missing required argument 'command'", IsError: true}, nil
	}
	if ec.Executor == nil {
		return Result{}, fmt.Errorf("bash: no executor configured")
	}
	var env []string
	if len(ec.Env) > 0 {
		// Layer the per-session env/secrets on top of the host environment.
		env = append(os.Environ(), ec.Env...)
	}
	res, err := ec.Executor.Exec(ctx, bay.ExecSpec{
		Argv: []string{"/bin/sh", "-c", cmd},
		Cwd:  ec.Cwd,
		Env:  env,
	})
	if err != nil {
		return Result{}, err
	}
	out := res.Stdout + res.Stderr
	if res.TimedOut {
		return Result{Content: out + "\n[command timed out]", IsError: true}, nil
	}
	return Result{Content: out, IsError: res.ExitCode != 0}, nil
}
