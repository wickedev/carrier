package lsp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"testing"
)

// mockSpawn substitutes a client wired to an in-process mock server.
func mockSpawn(_ context.Context, _ string, _ ...string) (*Client, error) {
	cliR, srvW := io.Pipe()
	srvR, cliW := io.Pipe()
	srv := &mockServer{in: bufio.NewReader(srvR), out: srvW}
	go srv.run()
	return newClient(cliW, cliR, func() error { _ = cliW.Close(); _ = srvW.Close(); return nil }), nil
}

func TestManagerDiagnosticsAndReuse(t *testing.T) {
	orig := spawn
	t.Cleanup(func() { spawn = orig })
	var spawns int
	spawn = func(ctx context.Context, cmd string, args ...string) (*Client, error) {
		spawns++
		return mockSpawn(ctx, cmd, args...)
	}

	m := NewManager(context.Background(), "/root")
	t.Cleanup(m.Close)

	diags, received, err := m.Diagnostics(context.Background(), "/root/a.go", "package main")
	if err != nil {
		t.Fatalf("Diagnostics: %v", err)
	}
	if !received || len(diags) != 1 || diags[0].Message != "undefined: Foo" {
		t.Fatalf("unexpected diagnostics: %+v received=%v", diags, received)
	}
	// A second Go file reuses the same gopls instance (no extra spawn).
	if _, _, err := m.Diagnostics(context.Background(), "/root/b.go", "package main"); err != nil {
		t.Fatalf("second Diagnostics: %v", err)
	}
	if spawns != 1 {
		t.Fatalf("expected one server spawn shared across .go files, got %d", spawns)
	}
}

// Re-running on the SAME file after an edit must return the FRESH diagnostics
// (via didChange), not the stale set cached from the first open.
func TestManagerReopenReturnsFreshDiagnostics(t *testing.T) {
	orig := spawn
	t.Cleanup(func() { spawn = orig })
	spawn = mockSpawn

	m := NewManager(context.Background(), "/root")
	t.Cleanup(m.Close)

	d1, ok1, err := m.Diagnostics(context.Background(), "/root/a.go", "v1")
	if err != nil || !ok1 || d1[0].Message != "undefined: Foo" {
		t.Fatalf("first: %+v ok=%v err=%v", d1, ok1, err)
	}
	d2, ok2, err := m.Diagnostics(context.Background(), "/root/a.go", "v2-edited")
	if err != nil || !ok2 {
		t.Fatalf("second errored: ok=%v err=%v", ok2, err)
	}
	if d2[0].Message != "changed: Bar" {
		t.Fatalf("re-open returned stale diagnostics: %+v (want fresh 'changed: Bar')", d2)
	}
}

func TestManagerHover(t *testing.T) {
	orig := spawn
	t.Cleanup(func() { spawn = orig })
	spawn = mockSpawn

	m := NewManager(context.Background(), "/root")
	t.Cleanup(m.Close)
	got, err := m.Hover(context.Background(), "/root/a.go", "package main", 0, 0)
	if err != nil {
		t.Fatalf("Hover: %v", err)
	}
	if got != "func Foo()" {
		t.Fatalf("hover = %q", got)
	}
}

func TestManagerUnsupportedExt(t *testing.T) {
	m := NewManager(context.Background(), "/root")
	if _, _, err := m.Diagnostics(context.Background(), "/root/a.zzz", "x"); err == nil {
		t.Fatal("expected an error for an unsupported file type")
	}
	if Supported("/root/a.zzz") {
		t.Fatal("Supported should be false for .zzz")
	}
	if !Supported("/root/a.go") {
		t.Fatal("Supported should be true for .go")
	}
}

func TestManagerSpawnFailureIsCached(t *testing.T) {
	orig := spawn
	t.Cleanup(func() { spawn = orig })
	var attempts int
	spawn = func(context.Context, string, ...string) (*Client, error) {
		attempts++
		return nil, errors.New("not installed")
	}
	m := NewManager(context.Background(), "/root")
	if _, _, err := m.Diagnostics(context.Background(), "/root/a.go", "x"); err == nil {
		t.Fatal("expected spawn failure")
	}
	if _, _, err := m.Diagnostics(context.Background(), "/root/b.go", "x"); err == nil {
		t.Fatal("expected the cached failure to still error")
	}
	if attempts != 1 {
		t.Fatalf("a failed server must be attempted once and cached, got %d attempts", attempts)
	}
}

func TestPathToURI(t *testing.T) {
	if got := PathToURI("/root/a.go"); got != "file:///root/a.go" {
		t.Fatalf("PathToURI = %q", got)
	}
	if PathToURI("") != "" {
		t.Fatal("empty path should map to empty URI")
	}
}
