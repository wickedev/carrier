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
		ToolName: "bash",
		ToolDescription: "Run a shell command in the session sandbox. Set run_in_background to " +
			"launch a long-running command (dev server, watcher, build) without blocking; it " +
			"returns a shell ID — read its output with bash_output and stop it with kill_shell.",
		ToolSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{
					"type":        "string",
					"description": "The shell command to run.",
				},
				"run_in_background": map[string]any{
					"type":        "boolean",
					"description": "Run the command in the background and return a shell ID immediately.",
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
	spec := bay.ExecSpec{
		Argv: []string{"/bin/sh", "-c", cmd},
		Cwd:  ec.Cwd,
		Env:  env,
	}

	// Background mode: launch and return a shell ID immediately. The process is
	// tracked in the session's registry (reaped on session end); its output is
	// read via bash_output and it is stopped via kill_shell.
	if bg, _ := input["run_in_background"].(bool); bg {
		if ec.Shells == nil {
			return Result{Content: "error: background shells are not available in this context", IsError: true}, nil
		}
		proc, err := ec.Executor.Start(ec.Shells.Context(), spec)
		if err != nil {
			return Result{}, err
		}
		id := ec.Shells.Add(cmd, proc)
		return Result{Content: fmt.Sprintf(
			"Started background shell %s. Read its output with bash_output(bash_id=%q); stop it with kill_shell(shell_id=%q).",
			id, id, id)}, nil
	}

	res, err := ec.Executor.Exec(ctx, spec)
	if err != nil {
		return Result{}, err
	}
	out := res.Stdout + res.Stderr
	if res.TimedOut {
		return Result{Content: out + "\n[command timed out]", IsError: true}, nil
	}
	return Result{Content: out, IsError: res.ExitCode != 0}, nil
}
