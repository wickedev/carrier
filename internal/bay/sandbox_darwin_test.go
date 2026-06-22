//go:build darwin

package bay

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSeatbeltConfinesWrites is the core escape test (Req 5.4): with WriteRoots
// limited to one temp dir, a write OUTSIDE that root must fail, while a write
// INSIDE it succeeds and a read of an outside file still works.
func TestSeatbeltConfinesWrites(t *testing.T) {
	e := NewSeatbeltExecutor()
	ctx := context.Background()

	writeRoot := t.TempDir()

	// The "outside" location must be outside BOTH the write root and $TMPDIR
	// (the sandbox additionally allows $TMPDIR, and t.TempDir() lives under it).
	// The user's home directory is writable on the host but not in the sandbox.
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	outsideDir, err := os.MkdirTemp(home, "carrier-seatbelt-test-")
	if err != nil {
		t.Fatalf("MkdirTemp in home: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(outsideDir) })

	// Seed an existing outside file so we can prove reads still work.
	readableOutside := filepath.Join(outsideDir, "readable.txt")
	if err := os.WriteFile(readableOutside, []byte("secret-contents"), 0o644); err != nil {
		t.Fatalf("seed readable file: %v", err)
	}

	// 1. Write OUTSIDE the write root must be DENIED.
	outsideTarget := filepath.Join(outsideDir, "escaped.txt")
	res, err := e.Exec(ctx, ExecSpec{
		Argv:       []string{"/bin/sh", "-c", "echo x > " + shellQuote(outsideTarget)},
		WriteRoots: []string{writeRoot},
		Network:    NetNone,
	})
	if err != nil {
		t.Fatalf("Exec (outside write): %v", err)
	}
	if res.ExitCode == 0 {
		t.Fatalf("escape: write outside write root unexpectedly succeeded (exit 0)")
	}
	if _, statErr := os.Stat(outsideTarget); statErr == nil {
		t.Fatalf("escape: outside file %q was created despite confinement", outsideTarget)
	}

	// 2. Write INSIDE the write root must SUCCEED.
	insideTarget := filepath.Join(writeRoot, "ok.txt")
	res, err = e.Exec(ctx, ExecSpec{
		Argv:       []string{"/bin/sh", "-c", "echo inside > " + shellQuote(insideTarget)},
		WriteRoots: []string{writeRoot},
		Network:    NetNone,
	})
	if err != nil {
		t.Fatalf("Exec (inside write): %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("inside write failed: exit=%d stderr=%q", res.ExitCode, res.Stderr)
	}
	if _, statErr := os.Stat(insideTarget); statErr != nil {
		t.Fatalf("inside file %q was not created: %v", insideTarget, statErr)
	}

	// 3. Read of an outside file must still WORK (broad file-read*).
	res, err = e.Exec(ctx, ExecSpec{
		Argv:       []string{"/bin/cat", readableOutside},
		WriteRoots: []string{writeRoot},
		Network:    NetNone,
	})
	if err != nil {
		t.Fatalf("Exec (outside read): %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("outside read failed: exit=%d stderr=%q", res.ExitCode, res.Stderr)
	}
	if got := res.Stdout; got == "" || !strings.Contains(got, "secret-contents") {
		t.Fatalf("outside read returned %q, want it to contain the file contents", got)
	}
}

// TestSeatbeltInsideWriteRunsNormally sanity-checks that an ordinary program
// runs to completion under the sandbox (process-exec / fork allowed).
func TestSeatbeltNormalProgramRuns(t *testing.T) {
	e := NewSeatbeltExecutor()
	res, err := e.Exec(context.Background(), ExecSpec{
		Argv:       []string{"/bin/echo", "hello-sandbox"},
		WriteRoots: []string{t.TempDir()},
		Network:    NetNone,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d stderr=%q", res.ExitCode, res.Stderr)
	}
	if !strings.Contains(res.Stdout, "hello-sandbox") {
		t.Fatalf("stdout=%q, want hello-sandbox", res.Stdout)
	}
}

// TestSeatbeltHelperPathValidationRejectsBogus proves the hardcoded-helper
// validation (Req 5.5) rejects a non-existent / non-PATH-resolved path.
func TestSeatbeltHelperPathValidationRejectsBogus(t *testing.T) {
	// A bogus absolute path that does not exist.
	if err := validateHelperPath(filepath.Join(t.TempDir(), "no-such-sandbox-exec")); err == nil {
		t.Fatal("expected validateHelperPath to reject a non-existent path")
	}
	// A relative path (would otherwise be PATH-resolved) must be rejected.
	if err := validateHelperPath("sandbox-exec"); err == nil {
		t.Fatal("expected validateHelperPath to reject a relative path")
	}
	// The real helper must validate (sanity check; skip if absent on this host).
	if _, statErr := os.Stat(seatbeltExecPath); statErr == nil {
		if err := validateHelperPath(seatbeltExecPath); err != nil {
			t.Fatalf("real helper %q rejected: %v", seatbeltExecPath, err)
		}
	}
}

// shellQuote single-quotes a path for safe embedding in `sh -c`.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
