//go:build darwin

package bay

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// seatbeltExecPath is the hardcoded macOS Seatbelt helper. It is NEVER resolved
// via PATH (Req 5.5): a PATH-injected "sandbox-exec" must not be able to stand
// in for the real one. The path is validated (stat) before each use.
const seatbeltExecPath = "/usr/bin/sandbox-exec"

// SeatbeltExecutor confines commands on macOS via the kernel sandbox, invoked as
//
//	/usr/bin/sandbox-exec -p <policy> -- <argv...>
//
// It generates an SBPL (Sandbox Profile Language) policy from the ExecSpec that
// denies by default, then re-opens the host broadly for READS while restricting
// WRITES to ExecSpec.WriteRoots (plus /dev/null and $TMPDIR). The result is a
// write-confined sandbox in which ordinary programs still run: they can fork,
// exec, read shared libraries, and read the filesystem, but cannot mutate the
// host outside the declared writable roots. Network is allowed only when
// spec.Network == NetFull.
//
// Execution reuses the shared runConfined helper (output cap, timeout,
// process-group SIGTERM->SIGKILL) by prepending the sandbox-exec prefix to
// spec.Argv.
type SeatbeltExecutor struct{}

// NewSeatbeltExecutor returns a macOS Seatbelt-backed isolating Executor.
func NewSeatbeltExecutor() *SeatbeltExecutor { return &SeatbeltExecutor{} }

// Close implements Executor.
func (e *SeatbeltExecutor) Close() error { return nil }

// wrap validates the hardcoded helper path and prepends the sandbox-exec prefix
// (with an SBPL policy from the spec) to the command. Shared by Exec and Start so
// foreground and background runs are confined identically.
func (e *SeatbeltExecutor) wrap(spec ExecSpec) ([]string, error) {
	if len(spec.Argv) == 0 {
		return nil, fmt.Errorf("bay: empty argv")
	}
	if err := validateHelperPath(seatbeltExecPath); err != nil {
		return nil, err
	}
	policy := buildSeatbeltPolicy(spec)
	// /usr/bin/sandbox-exec -p <policy> -- <argv...>
	argv := make([]string, 0, len(spec.Argv)+4)
	argv = append(argv, seatbeltExecPath, "-p", policy, "--")
	argv = append(argv, spec.Argv...)
	return argv, nil
}

// Exec implements Executor. It validates the hardcoded helper path, generates an
// SBPL policy from the spec, wraps the command, and runs it via runConfined.
func (e *SeatbeltExecutor) Exec(ctx context.Context, spec ExecSpec) (ExecResult, error) {
	argv, err := e.wrap(spec)
	if err != nil {
		return ExecResult{}, err
	}
	return runConfined(ctx, argv, spec)
}

// Start implements Executor: the same sandbox wrapping, run in the background.
func (e *SeatbeltExecutor) Start(ctx context.Context, spec ExecSpec) (*Process, error) {
	argv, err := e.wrap(spec)
	if err != nil {
		return nil, err
	}
	return startConfined(ctx, argv, spec)
}

// validateHelperPath stats a hardcoded sandbox-helper path and confirms it is a
// regular file. It must be an absolute path (never PATH-resolved) so that a
// hostile $PATH cannot substitute a fake helper (Req 5.5).
func validateHelperPath(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("bay: sandbox helper path %q is not absolute", path)
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("bay: sandbox helper %q not available: %w", path, err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return fmt.Errorf("bay: sandbox helper %q is not a regular file", path)
	}
	return nil
}

// buildSeatbeltPolicy renders an SBPL profile for spec. The profile denies by
// default, allows process/exec primitives and broad reads, restricts writes to
// the spec's WriteRoots (plus /dev/null and $TMPDIR), and allows network only
// when spec.Network == NetFull.
func buildSeatbeltPolicy(spec ExecSpec) string {
	var b strings.Builder

	b.WriteString("(version 1)")
	b.WriteString("(deny default)")

	// Process lifecycle: allow programs to run, fork, and exec children.
	b.WriteString("(allow process-fork)")
	b.WriteString("(allow process-exec)")
	b.WriteString("(allow signal (target same-sandbox))")

	// Common read-only system primitives most programs need to start.
	b.WriteString("(allow sysctl-read)")
	b.WriteString("(allow mach-lookup)")
	b.WriteString("(allow system-socket)")
	b.WriteString("(allow ipc-posix-shm)")

	// Broad reads: a write-confined sandbox still lets normal programs read the
	// host (shared libraries, configs, the source tree, etc.).
	b.WriteString("(allow file-read*)")

	// Writes are confined. Always permit /dev/null; permit $TMPDIR when set.
	// Each writable subpath is canonicalized (symlinks resolved) because the
	// kernel sandbox matches against the real path — on macOS /var, /tmp, and
	// $TMPDIR are symlinks under /private, so an un-resolved subpath would never
	// match and legitimate writes would be denied.
	var writeRules strings.Builder
	writeRules.WriteString("(subpath ")
	writeRules.WriteString(sbplString("/dev/null"))
	writeRules.WriteString(")")
	if tmp := os.Getenv("TMPDIR"); tmp != "" {
		writeRules.WriteString("(subpath ")
		writeRules.WriteString(sbplString(canonicalDir(tmp)))
		writeRules.WriteString(")")
	}
	for _, root := range spec.WriteRoots {
		root = canonicalDir(root)
		if root == "" {
			continue
		}
		writeRules.WriteString("(subpath ")
		writeRules.WriteString(sbplString(root))
		writeRules.WriteString(")")
	}
	b.WriteString("(allow file-write* ")
	b.WriteString(writeRules.String())
	b.WriteString(")")

	// Network: open only for NetFull; NetNone / NetRestricted stay denied by the
	// default-deny above.
	if spec.Network == NetFull {
		b.WriteString("(allow network*)")
	}

	return b.String()
}

// canonicalDir normalizes a writable-root path for use in an SBPL subpath: it
// strips a trailing slash and resolves symlinks (e.g. macOS /var -> /private/var)
// so the rendered subpath matches the kernel's canonicalized path. If symlink
// resolution fails (path may not exist yet), the cleaned absolute path is used.
func canonicalDir(p string) string {
	p = strings.TrimRight(p, "/")
	if p == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return strings.TrimRight(resolved, "/")
	}
	return p
}

// sbplString renders a Go string as an SBPL double-quoted literal, escaping
// backslashes and double quotes so paths with special characters cannot break
// out of the literal.
func sbplString(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `"` + r.Replace(s) + `"`
}
