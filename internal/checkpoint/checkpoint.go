// Package checkpoint provides workspace snapshotting for a Flight's working
// tree via a per-session BARE git repository. Snapshots are taken without
// polluting the working directory: there is no .git inside workDir. Instead,
// git is invoked with an explicit --git-dir (the bare repo) and --work-tree
// (the working directory), so the same workDir can be snapshotted, restored,
// and diffed without ever owning a repository of its own.
//
// This satisfies Requirement 8.5: snapshot the working tree, support restore,
// and produce a structured diff.
package checkpoint

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Checkpointer snapshots a working directory and can restore or diff against a
// previously captured snapshot.
type Checkpointer interface {
	// Commit stages all of the working tree and records a snapshot, returning
	// the resulting commit hash. If nothing changed since HEAD, it returns the
	// current HEAD hash without error.
	Commit(ctx context.Context, message string) (hash string, err error)
	// Restore hard-resets the working tree to exactly match the snapshot at
	// hash, including removing files added since that snapshot.
	Restore(ctx context.Context, hash string) error
	// Diff returns a structured diff of the current working tree against the
	// snapshot at hash.
	Diff(ctx context.Context, hash string) ([]FileDiff, error)
	// Revert is a convenience alias for Restore.
	Revert(ctx context.Context, hash string) error
}

// FileDiff describes one changed path between a snapshot and the current work
// tree. Status is one of "A" (added), "M" (modified), or "D" (deleted).
// Additions and Deletions are line counts from git's numstat; for binary files
// both are zero.
type FileDiff struct {
	Path      string
	Status    string
	Additions int
	Deletions int
}

// GitCheckpointer is a Checkpointer backed by a bare git repository.
type GitCheckpointer struct {
	bareDir string
	workDir string
}

// committer identity used for snapshot commits. It is set locally on the bare
// repo so snapshots never depend on the host's global git config.
const (
	committerName  = "Carrier Checkpoint"
	committerEmail = "checkpoint@carrier.local"
)

// New returns a GitCheckpointer for the given bare repository directory and
// working directory. If bareDir does not already contain a git repository it is
// initialized with `git init --bare`. A committer identity is configured
// locally on the bare repo.
func New(bareDir, workDir string) (*GitCheckpointer, error) {
	if bareDir == "" {
		return nil, fmt.Errorf("checkpoint: bareDir must not be empty")
	}
	if workDir == "" {
		return nil, fmt.Errorf("checkpoint: workDir must not be empty")
	}
	c := &GitCheckpointer{bareDir: bareDir, workDir: workDir}

	if !c.bareInitialized() {
		if err := os.MkdirAll(bareDir, 0o755); err != nil {
			return nil, fmt.Errorf("checkpoint: create bareDir: %w", err)
		}
		// `git init` rejects --work-tree, so run it without the work-tree prefix.
		if _, err := runGit(context.Background(), "init", "--bare", bareDir); err != nil {
			return nil, err
		}
	}

	if _, err := c.git(context.Background(), "config", "user.name", committerName); err != nil {
		return nil, err
	}
	if _, err := c.git(context.Background(), "config", "user.email", committerEmail); err != nil {
		return nil, err
	}
	return c, nil
}

// bareInitialized reports whether bareDir already holds a git repository.
func (c *GitCheckpointer) bareInitialized() bool {
	// A bare repo has a HEAD file at its root.
	if _, err := os.Stat(c.bareDir + string(os.PathSeparator) + "HEAD"); err == nil {
		return true
	}
	return false
}

// git runs a git command against the bare repo / work tree and returns its
// trimmed stdout. On failure the error includes captured stderr.
func (c *GitCheckpointer) git(ctx context.Context, args ...string) (string, error) {
	full := append([]string{
		"--git-dir=" + c.bareDir,
		"--work-tree=" + c.workDir,
	}, args...)
	return runGit(ctx, full...)
}

// runGit executes git with the exact args given (no implicit --git-dir /
// --work-tree) and returns trimmed stdout. On failure the error captures
// stderr.
func runGit(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("checkpoint: git %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

// head returns the current HEAD commit hash, or "" if there are no commits yet.
func (c *GitCheckpointer) head(ctx context.Context) (string, error) {
	out, err := c.git(ctx, "rev-parse", "HEAD")
	if err != nil {
		// No commits yet (unborn HEAD): not an error for our purposes.
		return "", nil
	}
	return out, nil
}

// Commit stages all of the work tree and records a snapshot. If nothing changed
// relative to HEAD, the current HEAD hash is returned with no error.
func (c *GitCheckpointer) Commit(ctx context.Context, message string) (string, error) {
	if _, err := c.git(ctx, "add", "-A"); err != nil {
		return "", err
	}

	// `git commit` exits non-zero when there is nothing to commit; detect that
	// case and return the existing HEAD instead of erroring.
	if clean, err := c.isClean(ctx); err != nil {
		return "", err
	} else if clean {
		return c.head(ctx)
	}

	if _, err := c.git(ctx, "commit", "-m", message); err != nil {
		return "", err
	}
	return c.head(ctx)
}

// isClean reports whether the index has no staged changes relative to HEAD.
func (c *GitCheckpointer) isClean(ctx context.Context) (bool, error) {
	head, err := c.head(ctx)
	if err != nil {
		return false, err
	}
	if head == "" {
		// Unborn HEAD: clean only if the index is empty too.
		out, err := c.git(ctx, "status", "--porcelain")
		if err != nil {
			return false, err
		}
		return out == "", nil
	}
	// `diff --cached --quiet` exits 0 when index == HEAD, 1 otherwise.
	full := []string{
		"--git-dir=" + c.bareDir,
		"--work-tree=" + c.workDir,
		"diff", "--cached", "--quiet",
	}
	cmd := exec.CommandContext(ctx, "git", full...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err = cmd.Run()
	if err == nil {
		return true, nil
	}
	if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("checkpoint: git diff --cached --quiet: %w: %s",
		err, strings.TrimSpace(stderr.String()))
}

// Restore hard-resets the work tree to exactly match the snapshot at hash.
// Files that were added after that snapshot are removed so the work tree
// reflects the snapshot byte-for-byte.
func (c *GitCheckpointer) Restore(ctx context.Context, hash string) error {
	if hash == "" {
		return fmt.Errorf("checkpoint: Restore: empty hash")
	}
	// Point HEAD and the index at the target snapshot.
	if _, err := c.git(ctx, "reset", "--hard", hash); err != nil {
		return err
	}
	// `reset --hard` restores tracked files but leaves files that became
	// untracked (i.e. added since the snapshot) in place. Remove them so the
	// work tree matches the snapshot exactly. -d also clears now-empty dirs.
	if _, err := c.git(ctx, "clean", "-fd"); err != nil {
		return err
	}
	return nil
}

// Revert is a convenience alias for Restore.
func (c *GitCheckpointer) Revert(ctx context.Context, hash string) error {
	return c.Restore(ctx, hash)
}

// Diff returns a structured diff of the current work tree against the snapshot
// at hash. Status comes from --name-status; line counts from --numstat.
func (c *GitCheckpointer) Diff(ctx context.Context, hash string) ([]FileDiff, error) {
	if hash == "" {
		return nil, fmt.Errorf("checkpoint: Diff: empty hash")
	}

	// Stage the whole work tree into the index so untracked (newly added) files
	// participate in the diff; `git diff <hash>` alone ignores untracked paths.
	// We then diff the index (--cached) against the snapshot. This leaves the
	// index staged, which is harmless: Commit re-runs `add -A` and a Restore
	// resets it.
	if _, err := c.git(ctx, "add", "-A"); err != nil {
		return nil, err
	}

	// Status per path: A / M / D (and copies/renames reduced to their letter).
	statusOut, err := c.git(ctx, "diff", "--cached", "--name-status", hash)
	if err != nil {
		return nil, err
	}
	status := parseNameStatus(statusOut)

	// Line counts per path.
	numOut, err := c.git(ctx, "diff", "--cached", "--numstat", hash)
	if err != nil {
		return nil, err
	}
	adds, dels, order := parseNumstat(numOut)

	diffs := make([]FileDiff, 0, len(order))
	seen := make(map[string]bool, len(order))
	for _, path := range order {
		st := status[path]
		if st == "" {
			st = "M"
		}
		diffs = append(diffs, FileDiff{
			Path:      path,
			Status:    st,
			Additions: adds[path],
			Deletions: dels[path],
		})
		seen[path] = true
	}
	// Include any path that appeared only in name-status (e.g. binary deletes
	// can still appear in both, but guard against numstat omissions).
	for path, st := range status {
		if seen[path] {
			continue
		}
		diffs = append(diffs, FileDiff{Path: path, Status: st})
	}
	return diffs, nil
}

// parseNameStatus parses `git diff --name-status` output into path->status.
// Each line is "<STATUS>\t<path>" where STATUS is A/M/D/R.../C.... For renames
// and copies (R100\told\tnew) the new path is used and reduced to its letter.
func parseNameStatus(out string) map[string]string {
	res := make(map[string]string)
	if out == "" {
		return res
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		code := fields[0]
		letter := string(code[0]) // A, M, D, R, C
		path := fields[len(fields)-1]
		res[path] = letter
	}
	return res
}

// parseNumstat parses `git diff --numstat` output. Each line is
// "<additions>\t<deletions>\t<path>"; binary files report "-\t-\t<path>".
// Returns additions and deletions keyed by path, plus the encounter order.
func parseNumstat(out string) (adds, dels map[string]int, order []string) {
	adds = make(map[string]int)
	dels = make(map[string]int)
	if out == "" {
		return adds, dels, order
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			continue
		}
		path := fields[2]
		// Renames render as "old => new"; take the destination path.
		if idx := strings.Index(path, " => "); idx >= 0 {
			path = path[idx+len(" => "):]
			path = strings.TrimRight(path, "}")
		}
		a, _ := strconv.Atoi(fields[0]) // "-" -> 0 for binary
		d, _ := strconv.Atoi(fields[1])
		adds[path] = a
		dels[path] = d
		order = append(order, path)
	}
	return adds, dels, order
}
