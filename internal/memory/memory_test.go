package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadInstructionsWalksUp(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "project", "pkg")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "project", "AGENTS.md"), []byte("OUTER"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte("INNER"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := LoadInstructions(sub, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "OUTER") || !strings.Contains(got, "INNER") {
		t.Fatalf("missing instructions: %q", got)
	}
	// Nearest (INNER) must appear after OUTER.
	if strings.Index(got, "OUTER") > strings.Index(got, "INNER") {
		t.Fatalf("expected OUTER before INNER (nearest last): %q", got)
	}
}

func TestLoadInstructionsPrefersAgentsOverClaude(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("A"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("C"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadInstructions(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "AGENTS.md") || strings.Contains(got, "CLAUDE.md") {
		t.Fatalf("expected AGENTS.md to win in a dir: %q", got)
	}
}

func TestLoadInstructionsEmpty(t *testing.T) {
	got, err := LoadInstructions(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestLoadInstructionsCap(t *testing.T) {
	dir := t.TempDir()
	big := strings.Repeat("x", 5000)
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadInstructions(dir, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) > 1000 {
		t.Fatalf("expected cap at 1000, got %d", len(got))
	}
}
