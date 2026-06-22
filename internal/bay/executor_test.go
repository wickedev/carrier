//go:build unix

package bay

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestLocalExecutorEcho(t *testing.T) {
	e := NewLocalExecutor()
	res, err := e.Exec(context.Background(), ExecSpec{Argv: []string{"/bin/echo", "hello"}})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if strings.TrimSpace(res.Stdout) != "hello" {
		t.Fatalf("stdout = %q, want hello", res.Stdout)
	}
}

func TestLocalExecutorExitCode(t *testing.T) {
	e := NewLocalExecutor()
	res, err := e.Exec(context.Background(), ExecSpec{Argv: []string{"/bin/sh", "-c", "exit 3"}})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.ExitCode != 3 {
		t.Fatalf("exit = %d, want 3", res.ExitCode)
	}
}

func TestLocalExecutorOutputCap(t *testing.T) {
	e := NewLocalExecutor()
	// Produce ~50KB of 'a'; cap to 1000 bytes.
	res, err := e.Exec(context.Background(), ExecSpec{
		Argv:      []string{"/bin/sh", "-c", "head -c 50000 /dev/zero | tr '\\0' a"},
		MaxOutput: 1000,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !res.OutputTruncated {
		t.Fatal("expected OutputTruncated=true")
	}
	if len(res.Stdout) > 1000 {
		t.Fatalf("stdout len = %d, want <= 1000", len(res.Stdout))
	}
}

func TestLocalExecutorTimeout(t *testing.T) {
	e := NewLocalExecutor()
	start := time.Now()
	res, err := e.Exec(context.Background(), ExecSpec{
		Argv:    []string{"/bin/sh", "-c", "sleep 5"},
		Timeout: 200 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !res.TimedOut {
		t.Fatal("expected TimedOut=true")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("took %v, expected timeout to kill well under 5s", elapsed)
	}
}

func TestLocalExecutorEmptyArgv(t *testing.T) {
	e := NewLocalExecutor()
	if _, err := e.Exec(context.Background(), ExecSpec{}); err == nil {
		t.Fatal("expected error on empty argv")
	}
}
