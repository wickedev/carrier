package tool

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/wickedev/carrier/internal/bay"
)

// BackgroundShell is one running background command tracked by a ShellRegistry.
type BackgroundShell struct {
	ID      string
	Command string
	proc    *bay.Process
}

// ShellRegistry tracks a session's background shells (started by bash with
// run_in_background). It owns a context whose cancellation kills every tracked
// process, so all background work is reaped when the session ends. Safe for
// concurrent use.
type ShellRegistry struct {
	ctx context.Context

	mu     sync.Mutex
	shells map[string]*BackgroundShell
	seq    int
}

// NewShellRegistry returns a registry whose tracked processes live until ctx is
// cancelled (or they are killed explicitly).
func NewShellRegistry(ctx context.Context) *ShellRegistry {
	return &ShellRegistry{ctx: ctx, shells: make(map[string]*BackgroundShell)}
}

// Context is the session-scoped context to pass to Executor.Start, so a started
// process is reaped when the session ends.
func (r *ShellRegistry) Context() context.Context { return r.ctx }

// Add registers a started process under a fresh shell ID and returns it.
func (r *ShellRegistry) Add(command string, proc *bay.Process) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	id := fmt.Sprintf("bash-%d", r.seq)
	r.shells[id] = &BackgroundShell{ID: id, Command: command, proc: proc}
	return id
}

// Get returns the shell registered under id.
func (r *ShellRegistry) Get(id string) (*BackgroundShell, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.shells[id]
	return s, ok
}

// Kill terminates a shell's process group and removes it. Returns false if the
// id is unknown.
func (r *ShellRegistry) Kill(id string) bool {
	r.mu.Lock()
	s, ok := r.shells[id]
	if ok {
		delete(r.shells, id)
	}
	r.mu.Unlock()
	if !ok {
		return false
	}
	s.proc.Kill()
	return true
}

// CloseAll kills every tracked shell. Called on session cleanup.
func (r *ShellRegistry) CloseAll() {
	r.mu.Lock()
	shells := make([]*BackgroundShell, 0, len(r.shells))
	for _, s := range r.shells {
		shells = append(shells, s)
	}
	r.shells = make(map[string]*BackgroundShell)
	r.mu.Unlock()
	for _, s := range shells {
		s.proc.Kill()
	}
}

// ── bash_output ──────────────────────────────────────────────────────────────

type bashOutputTool struct{ Base }

// NewBashOutput returns the bash_output tool: drain new output from a background
// shell started by bash with run_in_background.
func NewBashOutput() *bashOutputTool {
	return &bashOutputTool{Base{
		ToolName: "bash_output",
		ToolDescription: "Read new output from a background shell started by bash with " +
			"run_in_background. Returns output produced since the last read, plus whether " +
			"the shell is still running. Optionally filter output lines by a regular expression.",
		ReadOnly: true,
		ToolSchema: obj(props{
			"bash_id": strProp("The background shell ID returned by bash (e.g. \"bash-1\")."),
			"filter":  strProp("Optional regular expression; only matching output lines are returned."),
		}, "bash_id"),
	}}
}

func (bashOutputTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	id := strArg(input, "bash_id")
	if id == "" {
		return errResult("missing required argument 'bash_id'")
	}
	if ec.Shells == nil {
		return errResult("background shells are not available in this context")
	}
	shell, ok := ec.Shells.Get(id)
	if !ok {
		return errResult("no background shell with id %q", id)
	}

	// Compile the filter BEFORE draining: ReadNew is a destructive (drain-on-read)
	// call, so failing after it would silently discard that unread output. A bad
	// pattern must error without consuming anything.
	var re *regexp.Regexp
	if filter := strArg(input, "filter"); filter != "" {
		compiled, err := regexp.Compile(filter)
		if err != nil {
			return errResult("invalid filter regexp: %v", err)
		}
		re = compiled
	}

	out, running, truncated := shell.proc.ReadNew()

	if re != nil && out != "" {
		kept := make([]string, 0)
		for _, line := range strings.Split(out, "\n") {
			if re.MatchString(line) {
				kept = append(kept, line)
			}
		}
		out = strings.Join(kept, "\n")
	}

	var b strings.Builder
	if truncated {
		b.WriteString("[output truncated: backlog exceeded the cap]\n")
	}
	b.WriteString(out)
	if !running {
		finished, code := shell.proc.Status()
		if finished {
			fmt.Fprintf(&b, "\n[shell %s exited with code %d]", id, code)
		}
	}
	return Result{Content: b.String()}, nil
}

// ── write_stdin ──────────────────────────────────────────────────────────────

type writeStdinTool struct{ Base }

// NewWriteStdin returns the write_stdin tool: send input to a background shell's
// stdin (driving an interactive REPL or prompt started by bash run_in_background).
func NewWriteStdin() *writeStdinTool {
	return &writeStdinTool{Base{
		ToolName: "write_stdin",
		ToolDescription: "Write input to a background shell's stdin (started by bash with " +
			"run_in_background) — for driving interactive programs/REPLs. Include a trailing " +
			"newline (\\n) to submit a line. Read the program's response with bash_output.",
		ToolSchema: obj(props{
			"bash_id": strProp("The background shell ID to write to (e.g. \"bash-1\")."),
			"input":   strProp("The text to write to the shell's stdin (include \\n to submit a line)."),
		}, "bash_id", "input"),
	}}
}

func (writeStdinTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	id := strArg(input, "bash_id")
	if id == "" {
		return errResult("missing required argument 'bash_id'")
	}
	data, ok := input["input"].(string)
	if !ok {
		return errResult("missing required argument 'input'")
	}
	if ec.Shells == nil {
		return errResult("background shells are not available in this context")
	}
	shell, ok := ec.Shells.Get(id)
	if !ok {
		return errResult("no background shell with id %q", id)
	}
	if err := shell.proc.WriteStdin(data); err != nil {
		return errResult("%v", err)
	}
	return Result{Content: fmt.Sprintf("wrote %d bytes to %s", len(data), id)}, nil
}

// ── kill_shell ───────────────────────────────────────────────────────────────

type killShellTool struct{ Base }

// NewKillShell returns the kill_shell tool: terminate a background shell.
func NewKillShell() *killShellTool {
	return &killShellTool{Base{
		ToolName:        "kill_shell",
		ToolDescription: "Terminate a background shell (started by bash with run_in_background) by its ID.",
		ToolSchema: obj(props{
			"shell_id": strProp("The background shell ID to kill (e.g. \"bash-1\")."),
		}, "shell_id"),
	}}
}

func (killShellTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	id := strArg(input, "shell_id")
	if id == "" {
		return errResult("missing required argument 'shell_id'")
	}
	if ec.Shells == nil {
		return errResult("background shells are not available in this context")
	}
	if !ec.Shells.Kill(id) {
		return errResult("no background shell with id %q", id)
	}
	return Result{Content: fmt.Sprintf("killed background shell %s", id)}, nil
}

// sortedShellIDs is a small helper kept for deterministic listing in tests.
func sortedShellIDs(r *ShellRegistry) []string {
	r.mu.Lock()
	ids := make([]string, 0, len(r.shells))
	for id := range r.shells {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	sort.Strings(ids)
	return ids
}
