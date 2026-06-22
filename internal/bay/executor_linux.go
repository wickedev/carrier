//go:build linux

// UNVERIFIED ON THIS HOST.
//
// This file is the Linux counterpart to executor_darwin.go's SeatbeltExecutor.
// It was written and compiled (via `GOOS=linux go build`) on a darwin/arm64
// host and has NOT been run on Linux. The bubblewrap argv wrapping, namespace
// flags, and bind layout below are best-effort and MUST be validated on a real
// Linux box with bubblewrap installed before being relied on for confinement:
//
//   - confirm `bwrap` exists at one of the validated paths,
//   - confirm `--unshare-net` actually severs the network,
//   - confirm a write OUTSIDE the bound write roots is denied,
//   - confirm a write INSIDE a bound write root succeeds,
//   - confirm reads of the ro-bound host tree still work.
//
// The seccomp/Landlock hardening described in design.md (block ptrace,
// process_vm_*, io_uring) is NOT yet wired here; bubblewrap namespaces are the
// only isolation. Treat this as a scaffold, not a finished sandbox.
package bay

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// bwrapCandidates are the hardcoded bubblewrap helper locations, tried in order.
// As with the macOS helper, bwrap is NEVER resolved via PATH (Req 5.5): a
// PATH-injected "bwrap" must not be able to substitute for the real one.
var bwrapCandidates = []string{
	"/usr/bin/bwrap",
	"/usr/local/bin/bwrap",
	"/bin/bwrap",
}

// BwrapExecutor confines commands on Linux via bubblewrap, invoked roughly as:
//
//	bwrap --unshare-user --unshare-pid [--unshare-net] \
//	      --ro-bind / / --dev /dev --proc /proc \
//	      --bind <writeroot> <writeroot> ... \
//	      -- <argv...>
//
// The host filesystem is bound read-only at / so programs can read shared
// libraries and the source tree, while each ExecSpec.WriteRoots entry is
// re-bound read-write on top, yielding a write-confined view. PID and user
// namespaces are unshared; the network namespace is unshared (severing the
// network) unless spec.Network == NetFull.
//
// Execution reuses the shared runConfined helper (output cap, timeout,
// process-group SIGTERM->SIGKILL) by prepending the bwrap prefix to spec.Argv.
type BwrapExecutor struct{}

// NewBwrapExecutor returns a Linux bubblewrap-backed isolating Executor.
func NewBwrapExecutor() *BwrapExecutor { return &BwrapExecutor{} }

// Close implements Executor.
func (e *BwrapExecutor) Close() error { return nil }

// Exec implements Executor. It locates and validates the hardcoded bwrap helper,
// builds the namespace/bind wrapping from the spec, and runs it via runConfined.
func (e *BwrapExecutor) Exec(ctx context.Context, spec ExecSpec) (ExecResult, error) {
	if len(spec.Argv) == 0 {
		return ExecResult{}, fmt.Errorf("bay: empty argv")
	}
	bwrap, err := resolveBwrapPath()
	if err != nil {
		return ExecResult{}, err
	}

	argv := buildBwrapArgv(bwrap, spec)
	return runConfined(ctx, argv, spec)
}

// resolveBwrapPath returns the first valid hardcoded bwrap path, validating that
// it is an absolute regular file. PATH is never consulted (Req 5.5).
func resolveBwrapPath() (string, error) {
	for _, p := range bwrapCandidates {
		if err := validateHelperPath(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("bay: bubblewrap (bwrap) helper not found at %s", strings.Join(bwrapCandidates, ", "))
}

// buildBwrapArgv assembles the full bwrap command line for spec.
func buildBwrapArgv(bwrap string, spec ExecSpec) []string {
	argv := []string{
		bwrap,
		"--unshare-user",
		"--unshare-pid",
	}

	// Sever the network unless explicitly NetFull. NetNone and NetRestricted
	// both unshare the net namespace here (NetRestricted's loopback/proxy
	// carve-out is not yet implemented — see file-level UNVERIFIED note).
	if spec.Network != NetFull {
		argv = append(argv, "--unshare-net")
	}

	// Read-only host root, then a private /dev and /proc.
	argv = append(argv, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc")

	// Re-bind each write root read-write on top of the read-only root.
	seen := make(map[string]bool)
	for _, root := range spec.WriteRoots {
		root = strings.TrimRight(root, "/")
		if root == "" || !filepath.IsAbs(root) || seen[root] {
			continue
		}
		seen[root] = true
		argv = append(argv, "--bind", root, root)
	}

	argv = append(argv, "--")
	argv = append(argv, spec.Argv...)
	return argv
}

// validateHelperPath stats a hardcoded sandbox-helper path and confirms it is an
// absolute regular file, preventing a hostile $PATH from substituting a fake
// helper (Req 5.5).
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
