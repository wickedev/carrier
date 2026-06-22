package checkpoint

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func newCheckpointer(t *testing.T) (*GitCheckpointer, string) {
	t.Helper()
	bareDir := t.TempDir()
	workDir := t.TempDir()
	c, err := New(bareDir, workDir)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c, workDir
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func readFile(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

func TestCommitModifyDiffRestore(t *testing.T) {
	ctx := context.Background()
	c, work := newCheckpointer(t)

	writeFile(t, work, "a.txt", "line1\nline2\n")
	h1, err := c.Commit(ctx, "initial")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if h1 == "" {
		t.Fatal("expected non-empty hash for first commit")
	}

	// Modify the file and verify Diff reports it as Modified with line counts.
	writeFile(t, work, "a.txt", "line1\nCHANGED\nline3\n")

	diffs, err := c.Diff(ctx, h1)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(diffs) != 1 {
		t.Fatalf("expected 1 diff, got %d: %+v", len(diffs), diffs)
	}
	d := diffs[0]
	if d.Path != "a.txt" {
		t.Errorf("Path = %q, want a.txt", d.Path)
	}
	if d.Status != "M" {
		t.Errorf("Status = %q, want M", d.Status)
	}
	if d.Additions != 2 || d.Deletions != 1 {
		t.Errorf("counts: +%d -%d, want +2 -1", d.Additions, d.Deletions)
	}

	// Restore brings back the old content exactly.
	if err := c.Restore(ctx, h1); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := readFile(t, work, "a.txt"); got != "line1\nline2\n" {
		t.Errorf("after restore content = %q, want original", got)
	}
}

func TestRestoreRemovesAddedFile(t *testing.T) {
	ctx := context.Background()
	c, work := newCheckpointer(t)

	writeFile(t, work, "keep.txt", "keep\n")
	h1, err := c.Commit(ctx, "base")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Add a new file after the snapshot.
	writeFile(t, work, "extra/new.txt", "new\n")

	diffs, err := c.Diff(ctx, h1)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(diffs) != 1 || diffs[0].Status != "A" || diffs[0].Path != "extra/new.txt" {
		t.Fatalf("expected one added file extra/new.txt, got %+v", diffs)
	}

	// Restore must delete the file added since the snapshot.
	if err := c.Restore(ctx, h1); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "extra", "new.txt")); !os.IsNotExist(err) {
		t.Errorf("added file still present after restore (err=%v)", err)
	}
	// The kept file remains.
	if got := readFile(t, work, "keep.txt"); got != "keep\n" {
		t.Errorf("keep.txt = %q, want unchanged", got)
	}
}

func TestCommitNoChangeReturnsHead(t *testing.T) {
	ctx := context.Background()
	c, work := newCheckpointer(t)

	writeFile(t, work, "a.txt", "x\n")
	h1, err := c.Commit(ctx, "one")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// No changes: should return the same HEAD hash, no error, no new commit.
	h2, err := c.Commit(ctx, "noop")
	if err != nil {
		t.Fatalf("Commit (noop): %v", err)
	}
	if h2 != h1 {
		t.Errorf("noop commit hash = %q, want HEAD %q", h2, h1)
	}
}

func TestDiffDeletedFile(t *testing.T) {
	ctx := context.Background()
	c, work := newCheckpointer(t)

	writeFile(t, work, "gone.txt", "a\nb\n")
	h1, err := c.Commit(ctx, "base")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := os.Remove(filepath.Join(work, "gone.txt")); err != nil {
		t.Fatalf("remove: %v", err)
	}

	diffs, err := c.Diff(ctx, h1)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(diffs) != 1 || diffs[0].Status != "D" || diffs[0].Path != "gone.txt" {
		t.Fatalf("expected deletion of gone.txt, got %+v", diffs)
	}
	if diffs[0].Deletions != 2 {
		t.Errorf("deletions = %d, want 2", diffs[0].Deletions)
	}
}

func TestRevertAliasesRestore(t *testing.T) {
	ctx := context.Background()
	c, work := newCheckpointer(t)

	writeFile(t, work, "f.txt", "v1\n")
	h1, err := c.Commit(ctx, "v1")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	writeFile(t, work, "f.txt", "v2\n")
	if _, err := c.Commit(ctx, "v2"); err != nil {
		t.Fatalf("Commit v2: %v", err)
	}

	if err := c.Revert(ctx, h1); err != nil {
		t.Fatalf("Revert: %v", err)
	}
	if got := readFile(t, work, "f.txt"); got != "v1\n" {
		t.Errorf("after revert = %q, want v1", got)
	}
}

func TestReopenExistingBare(t *testing.T) {
	ctx := context.Background()
	bareDir := t.TempDir()
	workDir := t.TempDir()

	c1, err := New(bareDir, workDir)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	writeFile(t, workDir, "a.txt", "data\n")
	h1, err := c1.Commit(ctx, "init")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Reopening the same bare dir must not reinitialize and must see history.
	c2, err := New(bareDir, workDir)
	if err != nil {
		t.Fatalf("New (reopen): %v", err)
	}
	h2, err := c2.head(ctx)
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if h2 != h1 {
		t.Errorf("reopened HEAD = %q, want %q", h2, h1)
	}
}

// Compile-time check that GitCheckpointer satisfies Checkpointer.
var _ Checkpointer = (*GitCheckpointer)(nil)
