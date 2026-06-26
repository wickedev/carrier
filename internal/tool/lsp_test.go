package tool

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wickedev/carrier/internal/lsp"
)

func TestFormatDiagnostics(t *testing.T) {
	// Empty → a clean message.
	if got := formatDiagnostics("a.go", nil); !strings.Contains(got, "No diagnostics") {
		t.Errorf("empty format = %q", got)
	}
	// Sorted by position, 1-based, with severity + source.
	out := formatDiagnostics("a.go", []lsp.Diagnostic{
		{Line: 9, Char: 0, Severity: lsp.SeverityWarning, Message: "later"},
		{Line: 3, Char: 5, Severity: lsp.SeverityError, Message: "undefined: Foo", Source: "compiler"},
	})
	lines := strings.Split(out, "\n")
	if !strings.Contains(lines[0], "2 diagnostic(s)") {
		t.Fatalf("header = %q", lines[0])
	}
	// The error at 3:5 sorts before the warning at 9:0 and is 1-based → 4:6.
	if !strings.Contains(lines[1], "a.go:4:6: error: undefined: Foo [compiler]") {
		t.Fatalf("first diag line = %q", lines[1])
	}
	if !strings.Contains(lines[2], "a.go:10:1: warning: later") {
		t.Fatalf("second diag line = %q", lines[2])
	}
}

func TestLSPToolErrorsWithoutManager(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.go"), []byte("package main"), 0o644)
	res, _ := NewLSP().Exec(context.Background(),
		map[string]any{"path": "a.go"}, ExecContext{Cwd: dir}) // no LSP manager
	if !res.IsError {
		t.Fatal("expected an error when no LSP manager is configured")
	}
}

func TestLSPToolUnsupportedType(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "notes.zzz"), []byte("x"), 0o644)
	res, _ := NewLSP().Exec(context.Background(),
		map[string]any{"path": "notes.zzz"},
		ExecContext{Cwd: dir, LSP: lsp.NewManager(context.Background(), dir)})
	if !res.IsError {
		t.Fatal("expected an error for an unsupported file type")
	}
}

func TestLSPToolMissingFile(t *testing.T) {
	dir := t.TempDir()
	res, _ := NewLSP().Exec(context.Background(),
		map[string]any{"path": "ghost.go"},
		ExecContext{Cwd: dir, LSP: lsp.NewManager(context.Background(), dir)})
	if !res.IsError {
		t.Fatal("expected an error for a missing file")
	}
}
