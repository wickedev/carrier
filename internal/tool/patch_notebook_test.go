package tool

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyPatchTool(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "keep.txt"), "hello world\n")
	mustWrite(t, filepath.Join(dir, "gone.txt"), "delete me\n")

	r := run(t, NewApplyPatch(), dir, map[string]any{
		"operations": []any{
			map[string]any{"type": "create", "path": "new/a.txt", "content": "created\n"},
			map[string]any{"type": "edit", "path": "keep.txt", "edits": []any{
				map[string]any{"old_string": "world", "new_string": "Carrier"},
			}},
			map[string]any{"type": "delete", "path": "gone.txt"},
		},
	})
	if r.IsError {
		t.Fatalf("apply_patch: %+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "new", "a.txt")); string(b) != "created\n" {
		t.Fatalf("create: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "keep.txt")); string(b) != "hello Carrier\n" {
		t.Fatalf("edit: %q", b)
	}
	if _, err := os.Stat(filepath.Join(dir, "gone.txt")); err == nil {
		t.Fatal("delete: gone.txt still exists")
	}
}

func TestApplyPatchAtomicAbort(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.txt"), "alpha\n")

	// Second op fails (old_string not found) → first op must NOT be applied.
	r := run(t, NewApplyPatch(), dir, map[string]any{
		"operations": []any{
			map[string]any{"type": "create", "path": "should-not-exist.txt", "content": "x"},
			map[string]any{"type": "edit", "path": "a.txt", "edits": []any{
				map[string]any{"old_string": "nope", "new_string": "y"},
			}},
		},
	})
	if !r.IsError {
		t.Fatalf("apply_patch should fail: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(dir, "should-not-exist.txt")); err == nil {
		t.Fatal("atomicity broken: create was applied despite a later failure")
	}
}

func TestNotebookEditTool(t *testing.T) {
	dir := t.TempDir()
	nb := map[string]any{
		"cells": []any{
			map[string]any{"cell_type": "code", "metadata": map[string]any{}, "source": []any{"print(1)\n"}, "outputs": []any{}, "execution_count": nil},
		},
		"metadata": map[string]any{}, "nbformat": 4, "nbformat_minor": 5,
	}
	data, _ := json.Marshal(nb)
	mustWrite(t, filepath.Join(dir, "n.ipynb"), string(data))

	// replace
	r := run(t, NewNotebookEdit(), dir, map[string]any{
		"path": "n.ipynb", "cell_index": float64(0), "new_source": "print(42)\n", "edit_mode": "replace",
	})
	if r.IsError {
		t.Fatalf("replace: %+v", r)
	}
	// insert a markdown cell at the front
	r = run(t, NewNotebookEdit(), dir, map[string]any{
		"path": "n.ipynb", "cell_index": float64(0), "new_source": "# Title\n", "edit_mode": "insert", "cell_type": "markdown",
	})
	if r.IsError {
		t.Fatalf("insert: %+v", r)
	}
	out, _ := os.ReadFile(filepath.Join(dir, "n.ipynb"))
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("result not valid JSON: %v", err)
	}
	cells := got["cells"].([]any)
	if len(cells) != 2 {
		t.Fatalf("expected 2 cells, got %d", len(cells))
	}
	if cells[0].(map[string]any)["cell_type"] != "markdown" {
		t.Fatal("inserted cell should be markdown at index 0")
	}
	if !strings.Contains(string(out), "print(42)") {
		t.Fatalf("replace not applied: %s", out)
	}

	// .ipynb extension is required
	r = run(t, NewNotebookEdit(), dir, map[string]any{"path": "n.txt"})
	if !r.IsError || !strings.Contains(r.Content, ".ipynb") {
		t.Fatalf("non-ipynb should be rejected: %+v", r)
	}
}
