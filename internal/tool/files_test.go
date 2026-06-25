package tool

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func run(t *testing.T, tl Tool, cwd string, input map[string]any) Result {
	t.Helper()
	r, err := tl.Exec(context.Background(), input, ExecContext{Cwd: cwd})
	if err != nil {
		t.Fatalf("%s exec: %v", tl.Name(), err)
	}
	return r
}

func TestReadTool(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\nfour\n")

	r := run(t, NewRead(), dir, map[string]any{"path": "a.txt"})
	if r.IsError || !strings.Contains(r.Content, "     1\tone") || !strings.Contains(r.Content, "     4\tfour") {
		t.Fatalf("read full: %+v", r)
	}
	// Windowed read (offset/limit are float64 off the JSON path).
	r = run(t, NewRead(), dir, map[string]any{"path": "a.txt", "offset": float64(2), "limit": float64(2)})
	if !strings.Contains(r.Content, "     2\ttwo") || !strings.Contains(r.Content, "     3\tthree") || strings.Contains(r.Content, "four") {
		t.Fatalf("read window: %q", r.Content)
	}
}

func TestLsTool(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "f.txt"), "x")
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := run(t, NewLs(), dir, map[string]any{})
	if !strings.Contains(r.Content, "f.txt") || !strings.Contains(r.Content, "sub/") {
		t.Fatalf("ls: %q", r.Content)
	}
	if strings.Contains(r.Content, ".git") {
		t.Fatalf("ls should hide .git: %q", r.Content)
	}
}

func TestGlobTool(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "src", "a.go"), "package a")
	mustWrite(t, filepath.Join(dir, "src", "nested", "b.go"), "package b")
	mustWrite(t, filepath.Join(dir, "src", "c.ts"), "x")

	r := run(t, NewGlob(), dir, map[string]any{"pattern": "**/*.go"})
	if !strings.Contains(r.Content, "src/a.go") || !strings.Contains(r.Content, "src/nested/b.go") {
		t.Fatalf("glob **/*.go: %q", r.Content)
	}
	if strings.Contains(r.Content, "c.ts") {
		t.Fatalf("glob matched wrong ext: %q", r.Content)
	}
}

func TestGrepTool(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.go"), "package a\nfunc Hello() {}\n")
	mustWrite(t, filepath.Join(dir, "b.ts"), "const Hello = 1\n")

	r := run(t, NewGrep(), dir, map[string]any{"pattern": "Hello", "include": "*.go"})
	if !strings.Contains(r.Content, "a.go:2:") {
		t.Fatalf("grep include *.go: %q", r.Content)
	}
	if strings.Contains(r.Content, "b.ts") {
		t.Fatalf("grep include should exclude b.ts: %q", r.Content)
	}
}

func TestWriteAndEditTool(t *testing.T) {
	dir := t.TempDir()

	r := run(t, NewWrite(), dir, map[string]any{"path": "new/file.txt", "content": "alpha\nbeta\n"})
	if r.IsError {
		t.Fatalf("write: %+v", r)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "new", "file.txt"))
	if string(got) != "alpha\nbeta\n" {
		t.Fatalf("write content: %q", got)
	}

	// Unique edit succeeds.
	r = run(t, NewEdit(), dir, map[string]any{"path": "new/file.txt", "old_string": "beta", "new_string": "gamma"})
	if r.IsError {
		t.Fatalf("edit: %+v", r)
	}
	got, _ = os.ReadFile(filepath.Join(dir, "new", "file.txt"))
	if string(got) != "alpha\ngamma\n" {
		t.Fatalf("edit result: %q", got)
	}

	// Non-unique edit without replace_all errors.
	mustWrite(t, filepath.Join(dir, "dup.txt"), "x x x")
	r = run(t, NewEdit(), dir, map[string]any{"path": "dup.txt", "old_string": "x", "new_string": "y"})
	if !r.IsError || !strings.Contains(r.Content, "occurs 3 times") {
		t.Fatalf("non-unique edit should error: %+v", r)
	}
	// replace_all succeeds.
	r = run(t, NewEdit(), dir, map[string]any{"path": "dup.txt", "old_string": "x", "new_string": "y", "replace_all": true})
	if r.IsError {
		t.Fatalf("replace_all: %+v", r)
	}
	got, _ = os.ReadFile(filepath.Join(dir, "dup.txt"))
	if string(got) != "y y y" {
		t.Fatalf("replace_all result: %q", got)
	}
}

func TestMultiEditTool(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "f.txt"), "alpha beta gamma\n")

	r := run(t, NewMultiEdit(), dir, map[string]any{
		"path": "f.txt",
		"edits": []any{
			map[string]any{"old_string": "alpha", "new_string": "ALPHA"},
			map[string]any{"old_string": "gamma", "new_string": "GAMMA"},
		},
	})
	if r.IsError {
		t.Fatalf("multi_edit: %+v", r)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "ALPHA beta GAMMA\n" {
		t.Fatalf("multi_edit result: %q", got)
	}

	// A failing edit (not found) must abort all → file unchanged.
	r = run(t, NewMultiEdit(), dir, map[string]any{
		"path": "f.txt",
		"edits": []any{
			map[string]any{"old_string": "ALPHA", "new_string": "x"},
			map[string]any{"old_string": "nope", "new_string": "y"},
		},
	})
	if !r.IsError || !strings.Contains(r.Content, "edit 2") {
		t.Fatalf("multi_edit should abort on a missing edit: %+v", r)
	}
	got, _ = os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "ALPHA beta GAMMA\n" {
		t.Fatalf("multi_edit must not partially apply: %q", got)
	}
}

func TestPathTraversalRejected(t *testing.T) {
	dir := t.TempDir()
	for _, tl := range []Tool{NewRead(), NewWrite(), NewEdit(), NewLs()} {
		input := map[string]any{"path": "../escape.txt", "content": "x", "old_string": "a", "new_string": "b"}
		r, err := tl.Exec(context.Background(), input, ExecContext{Cwd: dir})
		if err != nil {
			t.Fatalf("%s err: %v", tl.Name(), err)
		}
		if !r.IsError || !strings.Contains(r.Content, "escapes the working directory") {
			t.Fatalf("%s should reject traversal: %+v", tl.Name(), r)
		}
	}
}

func TestSymlinkEscapeBlocked(t *testing.T) {
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	mustWrite(t, secret, "TOP SECRET\n")

	wc := t.TempDir()
	mustWrite(t, filepath.Join(wc, "ok.txt"), "fine\n")
	link := filepath.Join(wc, "link.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	// read/edit through the symlink must be rejected (it resolves outside wc).
	for _, tl := range []Tool{NewRead(), NewEdit()} {
		r := run(t, tl, wc, map[string]any{
			"path": "link.txt", "old_string": "TOP", "new_string": "x",
		})
		if !r.IsError || !strings.Contains(r.Content, "escapes the working directory") {
			t.Fatalf("%s via symlink should be rejected: %+v", tl.Name(), r)
		}
	}
	// The outside secret must be untouched.
	if b, _ := os.ReadFile(secret); string(b) != "TOP SECRET\n" {
		t.Fatalf("outside file was modified: %q", b)
	}

	// A DANGLING symlink to a missing outside target: write must be rejected and
	// must NOT create the outside file (EvalSymlinks can't resolve it, so the
	// guard relies on Lstat detecting the symlink component).
	danglingTarget := filepath.Join(outside, "created-via-symlink.txt")
	if err := os.Symlink(danglingTarget, filepath.Join(wc, "dangling.txt")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	r0 := run(t, NewWrite(), wc, map[string]any{"path": "dangling.txt", "content": "pwned"})
	if !r0.IsError || !strings.Contains(r0.Content, "escapes the working directory") {
		t.Fatalf("write through dangling symlink should be rejected: %+v", r0)
	}
	if _, err := os.Stat(danglingTarget); err == nil {
		t.Fatalf("write escaped: %s was created outside the working copy", danglingTarget)
	}
	// grep/glob must skip the symlink (never surface or read it).
	r := run(t, NewGrep(), wc, map[string]any{"pattern": "SECRET"})
	if !strings.Contains(r.Content, "no matches") {
		t.Fatalf("grep should not read the symlinked secret: %q", r.Content)
	}
	r = run(t, NewGlob(), wc, map[string]any{"pattern": "**/*.txt"})
	if strings.Contains(r.Content, "link.txt") || !strings.Contains(r.Content, "ok.txt") {
		t.Fatalf("glob should skip the symlink but keep real files: %q", r.Content)
	}
}

func TestReadOnlyAndConcurrencyFlags(t *testing.T) {
	readOnly := map[string]bool{"read": true, "ls": true, "glob": true, "grep": true, "write": false, "edit": false}
	tools := []Tool{NewRead(), NewLs(), NewGlob(), NewGrep(), NewWrite(), NewEdit()}
	for _, tl := range tools {
		want := readOnly[tl.Name()]
		if tl.IsReadOnly(nil) != want {
			t.Errorf("%s IsReadOnly = %v, want %v", tl.Name(), tl.IsReadOnly(nil), want)
		}
		// Read-only file tools must be concurrency-safe (parallel dispatch + plan mode).
		if want && !tl.IsConcurrencySafe(nil) {
			t.Errorf("%s should be concurrency-safe", tl.Name())
		}
	}
}
