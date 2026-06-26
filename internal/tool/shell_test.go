package tool

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/bay"
)

// execCtxWithShells builds an ExecContext with a real LocalExecutor and a fresh
// shell registry bound to ctx.
func execCtxWithShells(ctx context.Context) ExecContext {
	return ExecContext{
		Executor: bay.NewLocalExecutor(),
		Shells:   NewShellRegistry(ctx),
	}
}

func TestBashBackgroundThenOutputThenKill(t *testing.T) {
	ec := execCtxWithShells(context.Background())

	// Launch a background loop that prints lines over time.
	res, err := NewBash().Exec(context.Background(), map[string]any{
		"command":           "for i in 1 2 3; do echo line-$i; sleep 0.05; done; echo done-marker",
		"run_in_background": true,
	}, ec)
	if err != nil {
		t.Fatalf("bash background: %v", err)
	}
	if res.IsError {
		t.Fatalf("background start errored: %s", res.Content)
	}
	ids := sortedShellIDs(ec.Shells)
	if len(ids) != 1 {
		t.Fatalf("expected 1 tracked shell, got %v", ids)
	}
	id := ids[0]
	if !strings.Contains(res.Content, id) {
		t.Fatalf("start message missing shell id %q: %s", id, res.Content)
	}

	// Poll bash_output until the final marker shows up.
	out := NewBashOutput()
	var acc strings.Builder
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, err := out.Exec(context.Background(), map[string]any{"bash_id": id}, ec)
		if err != nil {
			t.Fatalf("bash_output: %v", err)
		}
		acc.WriteString(r.Content)
		if strings.Contains(acc.String(), "done-marker") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(acc.String(), "line-1") || !strings.Contains(acc.String(), "done-marker") {
		t.Fatalf("did not stream expected output, got %q", acc.String())
	}

	// kill_shell should succeed and de-register the shell.
	kr, err := NewKillShell().Exec(context.Background(), map[string]any{"shell_id": id}, ec)
	if err != nil || kr.IsError {
		t.Fatalf("kill_shell: err=%v res=%s", err, kr.Content)
	}
	if ids := sortedShellIDs(ec.Shells); len(ids) != 0 {
		t.Fatalf("shell still tracked after kill: %v", ids)
	}
}

func TestBashOutputFilter(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	res, _ := NewBash().Exec(context.Background(), map[string]any{
		"command":           "printf 'keep-a\\ndrop-b\\nkeep-c\\n'",
		"run_in_background": true,
	}, ec)
	id := sortedShellIDs(ec.Shells)[0]
	_ = res

	out := NewBashOutput()
	var acc strings.Builder
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r, _ := out.Exec(context.Background(), map[string]any{"bash_id": id, "filter": "^keep-"}, ec)
		acc.WriteString(r.Content)
		if strings.Contains(acc.String(), "keep-c") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	got := acc.String()
	if !strings.Contains(got, "keep-a") || !strings.Contains(got, "keep-c") {
		t.Fatalf("filter dropped kept lines: %q", got)
	}
	if strings.Contains(got, "drop-b") {
		t.Fatalf("filter did not drop non-matching line: %q", got)
	}
}

func TestBashOutputInvalidFilterPreservesOutput(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	NewBash().Exec(context.Background(), map[string]any{
		"command":           "printf 'alpha\\nbeta\\n'",
		"run_in_background": true,
	}, ec)
	id := sortedShellIDs(ec.Shells)[0]
	out := NewBashOutput()

	// Wait until output is buffered (process is finished/has produced output) by
	// polling with the INVALID filter: each call must error WITHOUT draining.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r, _ := out.Exec(context.Background(), map[string]any{"bash_id": id, "filter": "("}, ec)
		if !r.IsError {
			t.Fatalf("invalid filter should error, got %q", r.Content)
		}
		if fin, _ := func() (bool, int) {
			s, _ := ec.Shells.Get(id)
			return s.proc.Status()
		}(); fin {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// A valid read must still see the full output — the failed calls drained nothing.
	r, err := out.Exec(context.Background(), map[string]any{"bash_id": id}, ec)
	if err != nil || r.IsError {
		t.Fatalf("valid read failed: err=%v res=%s", err, r.Content)
	}
	if !strings.Contains(r.Content, "alpha") || !strings.Contains(r.Content, "beta") {
		t.Fatalf("output lost after invalid filter calls, got %q", r.Content)
	}
}

func TestWriteStdinDrivesInteractiveShell(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	// Start an interactive `cat`: it echoes whatever we write to its stdin.
	NewBash().Exec(context.Background(), map[string]any{
		"command":           "cat",
		"run_in_background": true,
	}, ec)
	id := sortedShellIDs(ec.Shells)[0]

	// Write a line to stdin.
	wr, err := NewWriteStdin().Exec(context.Background(), map[string]any{
		"bash_id": id,
		"input":   "hello-repl\n",
	}, ec)
	if err != nil || wr.IsError {
		t.Fatalf("write_stdin: err=%v res=%s", err, wr.Content)
	}

	// cat should echo it back; read via bash_output.
	out := NewBashOutput()
	var acc strings.Builder
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r, _ := out.Exec(context.Background(), map[string]any{"bash_id": id}, ec)
		acc.WriteString(r.Content)
		if strings.Contains(acc.String(), "hello-repl") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(acc.String(), "hello-repl") {
		t.Fatalf("interactive echo not observed, got %q", acc.String())
	}
	ec.Shells.Kill(id)
}

func TestWriteStdinUnknownID(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	r, _ := NewWriteStdin().Exec(context.Background(), map[string]any{
		"bash_id": "bash-99", "input": "x",
	}, ec)
	if !r.IsError {
		t.Fatal("expected error for unknown shell id")
	}
}

func TestWriteStdinAfterExitErrors(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	NewBash().Exec(context.Background(), map[string]any{
		"command":           "true",
		"run_in_background": true,
	}, ec)
	id := sortedShellIDs(ec.Shells)[0]
	// Wait for the process to exit.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		shell, _ := ec.Shells.Get(id)
		if fin, _ := shell.proc.Status(); fin {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	r, _ := NewWriteStdin().Exec(context.Background(), map[string]any{
		"bash_id": id, "input": "x",
	}, ec)
	if !r.IsError {
		t.Fatal("expected error writing to an exited shell")
	}
}

func TestWriteStdinMissingInput(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	NewBash().Exec(context.Background(), map[string]any{
		"command": "cat", "run_in_background": true,
	}, ec)
	id := sortedShellIDs(ec.Shells)[0]
	r, _ := NewWriteStdin().Exec(context.Background(), map[string]any{"bash_id": id}, ec)
	if !r.IsError {
		t.Fatal("expected error for missing 'input'")
	}
	ec.Shells.Kill(id)
}

func TestBashOutputUnknownID(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	r, _ := NewBashOutput().Exec(context.Background(), map[string]any{"bash_id": "bash-99"}, ec)
	if !r.IsError {
		t.Fatal("expected error for unknown shell id")
	}
}

func TestBashBackgroundWithoutRegistry(t *testing.T) {
	ec := ExecContext{Executor: bay.NewLocalExecutor()} // no Shells
	r, err := NewBash().Exec(context.Background(), map[string]any{
		"command":           "echo hi",
		"run_in_background": true,
	}, ec)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !r.IsError {
		t.Fatal("expected error when no shell registry is available")
	}
}

func TestKillShellUnknownID(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	r, _ := NewKillShell().Exec(context.Background(), map[string]any{"shell_id": "bash-99"}, ec)
	if !r.IsError {
		t.Fatal("expected error killing unknown shell id")
	}
}

func TestShellRegistryCloseAllKills(t *testing.T) {
	ec := execCtxWithShells(context.Background())
	NewBash().Exec(context.Background(), map[string]any{
		"command":           "sleep 30",
		"run_in_background": true,
	}, ec)
	id := sortedShellIDs(ec.Shells)[0]
	shell, ok := ec.Shells.Get(id)
	if !ok {
		t.Fatal("shell not registered")
	}
	ec.Shells.CloseAll()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fin, _ := shell.proc.Status(); fin {
			if ids := sortedShellIDs(ec.Shells); len(ids) != 0 {
				t.Fatalf("CloseAll left shells tracked: %v", ids)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("CloseAll did not kill the background process")
}
