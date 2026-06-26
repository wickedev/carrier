package bay

import (
	"context"
	"strings"
	"testing"
	"time"
)

// drainUntil polls ReadNew until the accumulated output contains want or the
// deadline passes. Returns the full accumulated output.
func drainUntil(t *testing.T, p *Process, want string) string {
	t.Helper()
	var acc strings.Builder
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out, _, _ := p.ReadNew()
		acc.WriteString(out)
		if strings.Contains(acc.String(), want) {
			return acc.String()
		}
		time.Sleep(5 * time.Millisecond)
	}
	return acc.String()
}

func TestProcessStreamsOutputThenExits(t *testing.T) {
	e := NewLocalExecutor()
	p, err := e.Start(context.Background(), ExecSpec{
		Argv: []string{"/bin/sh", "-c", "echo hello; echo world"},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	got := drainUntil(t, p, "world")
	if !strings.Contains(got, "hello") || !strings.Contains(got, "world") {
		t.Fatalf("missing output, got %q", got)
	}
	// Process should finish on its own with exit code 0.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fin, code := p.Status(); fin {
			if code != 0 {
				t.Fatalf("exit code = %d, want 0", code)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("process never finished")
}

func TestProcessWriteStdin(t *testing.T) {
	e := NewLocalExecutor()
	p, err := e.Start(context.Background(), ExecSpec{Argv: []string{"/bin/cat"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := p.WriteStdin("ping\n"); err != nil {
		t.Fatalf("WriteStdin: %v", err)
	}
	got := drainUntil(t, p, "ping")
	if !strings.Contains(got, "ping") {
		t.Fatalf("cat did not echo stdin, got %q", got)
	}
	p.Kill()
}

func TestProcessKillStops(t *testing.T) {
	e := NewLocalExecutor()
	p, err := e.Start(context.Background(), ExecSpec{Argv: []string{"/bin/sh", "-c", "sleep 30"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	p.Kill()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fin, _ := p.Status(); fin {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("killed process never reported finished")
}

func TestProcessContextCancelReaps(t *testing.T) {
	e := NewLocalExecutor()
	ctx, cancel := context.WithCancel(context.Background())
	p, err := e.Start(ctx, ExecSpec{Argv: []string{"/bin/sh", "-c", "sleep 30"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	cancel() // session ended → the watcher must kill the group
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fin, _ := p.Status(); fin {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("context cancel did not reap the process")
}

func TestProcessWriteStdinAfterExitErrors(t *testing.T) {
	e := NewLocalExecutor()
	p, err := e.Start(context.Background(), ExecSpec{Argv: []string{"/bin/sh", "-c", "true"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Wait for it to finish.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fin, _ := p.Status(); fin {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := p.WriteStdin("x"); err == nil {
		t.Fatal("WriteStdin after exit should error")
	}
}
