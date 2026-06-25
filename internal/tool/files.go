package tool

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// First-class file tools (read / ls / glob / grep / write / edit). They give the
// model structured, sandbox-scoped file access instead of forcing every file
// operation through `bash` (cat/sed/grep/find). The read-only ones (read, ls,
// glob, grep) are marked concurrency-safe so the Flight can dispatch them in
// parallel and so they remain available in plan mode (which hides mutating
// tools). All paths are resolved against and confined to the session's working
// copy (ExecContext.Cwd).

const (
	defaultReadLimit = 2000  // lines
	maxLineLen       = 2000  // chars per line in `read`
	maxGrepMatches   = 200   // total matches returned by `grep`
	maxGlobResults   = 500   // paths returned by `glob`
	maxListEntries   = 1000  // entries returned by `ls`
	maxScanFileBytes = 5 << 20 // skip files larger than this in grep
)

// resolveInCwd resolves a model-supplied path against cwd and rejects anything
// that escapes it — including via SYMLINKS (a repo may contain a symlink pointing
// outside the working copy). Relative paths are joined onto cwd; the returned
// path is the cleaned absolute path to operate on.
func resolveInCwd(cwd, p string) (string, error) {
	if cwd == "" {
		return "", fmt.Errorf("no working directory configured")
	}
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("missing required argument 'path'")
	}
	// Canonical root (resolves e.g. /tmp → /private/tmp so the containment check
	// compares like-for-like real paths).
	root, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return "", fmt.Errorf("working directory: %w", err)
	}
	abs := p
	if !filepath.IsAbs(p) {
		abs = filepath.Join(root, p)
	}
	abs = filepath.Clean(abs)
	if err := confined(root, abs); err != nil {
		return "", err
	}
	return abs, nil
}

// confined verifies abs is inside root with NO symlink component along the way.
// It Lstats each existing path component from root down; a symlink (even a
// dangling one pointing outside — Lstat does not follow it) is rejected, which
// blocks both `../` traversal and symlink escapes (including `write` creating a
// file through a dangling symlink). The first non-existent component ends the
// walk: the rest is the to-be-created tail and is safe, since every existing
// ancestor was confirmed to be a real directory within root.
func confined(root, abs string) error {
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("path escapes the working directory: %s", abs)
	}
	if rel == "." {
		return nil
	}
	cur := root
	for _, comp := range strings.Split(rel, string(os.PathSeparator)) {
		cur = filepath.Join(cur, comp)
		fi, lerr := os.Lstat(cur)
		if lerr != nil {
			return nil // component (and remainder) does not exist yet
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path escapes the working directory via symlink: %s", cur)
		}
	}
	return nil
}

func strArg(input map[string]any, key string) string {
	s, _ := input[key].(string)
	return s
}

func intArg(input map[string]any, key string) (int, bool) {
	switch v := input[key].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

func errResult(format string, a ...any) (Result, error) {
	return Result{Content: "error: " + fmt.Sprintf(format, a...), IsError: true}, nil
}

// ── read ─────────────────────────────────────────────────────────────────────

type readTool struct{ Base }

// NewRead returns the read tool: numbered file contents with optional
// offset/limit windowing.
func NewRead() *readTool {
	return &readTool{Base{
		ToolName: "read",
		ToolDescription: "Read a UTF-8 text file from the session working copy. Returns " +
			"line-numbered content. Use offset/limit to window large files.",
		ReadOnly:        true,
		ConcurrencySafe: true,
		ToolSchema: obj(props{
			"path":   strProp("File path (relative to the working copy or absolute within it)."),
			"offset": intProp("1-indexed line to start from (optional)."),
			"limit":  intProp("Maximum number of lines to read (optional; default 2000)."),
		}, "path"),
	}}
}

func (readTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	abs, err := resolveInCwd(ec.Cwd, strArg(input, "path"))
	if err != nil {
		return errResult("%v", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return errResult("%v", err)
	}
	if info.IsDir() {
		return errResult("%s is a directory; use ls", strArg(input, "path"))
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return errResult("%v", err)
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return errResult("%s appears to be a binary file", strArg(input, "path"))
	}
	offset := 1
	if o, ok := intArg(input, "offset"); ok && o > 0 {
		offset = o
	}
	limit := defaultReadLimit
	if l, ok := intArg(input, "limit"); ok && l > 0 {
		limit = l
	}
	lines := strings.Split(string(data), "\n")
	var b strings.Builder
	end := offset - 1 + limit
	for i := offset - 1; i < len(lines) && i < end; i++ {
		line := lines[i]
		if len(line) > maxLineLen {
			line = line[:maxLineLen] + "… (truncated)"
		}
		fmt.Fprintf(&b, "%6d\t%s\n", i+1, line)
	}
	if b.Len() == 0 {
		return Result{Content: "(no lines in the requested range)"}, nil
	}
	return Result{Content: b.String()}, nil
}

// ── ls ───────────────────────────────────────────────────────────────────────

type lsTool struct{ Base }

// NewLs returns the ls tool: a single-directory listing.
func NewLs() *lsTool {
	return &lsTool{Base{
		ToolName:        "ls",
		ToolDescription: "List the entries of a directory in the working copy (directories end with '/').",
		ReadOnly:        true,
		ConcurrencySafe: true,
		ToolSchema: obj(props{
			"path": strProp("Directory path (optional; defaults to the working-copy root)."),
		}),
	}}
}

func (lsTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	p := strArg(input, "path")
	if strings.TrimSpace(p) == "" {
		p = "."
	}
	abs, err := resolveInCwd(ec.Cwd, p)
	if err != nil {
		return errResult("%v", err)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return errResult("%v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.Name() == ".git" {
			continue
		}
		if e.IsDir() {
			names = append(names, e.Name()+"/")
		} else {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) > maxListEntries {
		names = append(names[:maxListEntries], fmt.Sprintf("… (%d more)", len(names)-maxListEntries))
	}
	if len(names) == 0 {
		return Result{Content: "(empty directory)"}, nil
	}
	return Result{Content: strings.Join(names, "\n")}, nil
}

// ── glob ─────────────────────────────────────────────────────────────────────

type globTool struct{ Base }

// NewGlob returns the glob tool: file-name pattern matching (supports **).
func NewGlob() *globTool {
	return &globTool{Base{
		ToolName: "glob",
		ToolDescription: "Find files by glob pattern (supports ** for any depth, e.g. '**/*.go'). " +
			"Returns matching paths relative to the working copy.",
		ReadOnly:        true,
		ConcurrencySafe: true,
		ToolSchema: obj(props{
			"pattern": strProp("Glob pattern, e.g. '**/*.ts' or 'src/*.go'."),
			"path":    strProp("Base directory to search from (optional; defaults to the root)."),
		}, "pattern"),
	}}
}

func (globTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	pattern := strArg(input, "pattern")
	if strings.TrimSpace(pattern) == "" {
		return errResult("missing required argument 'pattern'")
	}
	re, err := globToRegexp(pattern)
	if err != nil {
		return errResult("invalid pattern: %v", err)
	}
	base := strArg(input, "path")
	if strings.TrimSpace(base) == "" {
		base = "."
	}
	absBase, err := resolveInCwd(ec.Cwd, base)
	if err != nil {
		return errResult("%v", err)
	}
	var matches []string
	walk(absBase, func(rel string, isDir bool) bool {
		if isDir {
			return true
		}
		if re.MatchString(rel) {
			matches = append(matches, rel)
		}
		return len(matches) < maxGlobResults
	})
	sort.Strings(matches)
	if len(matches) == 0 {
		return Result{Content: "(no files matched)"}, nil
	}
	return Result{Content: strings.Join(matches, "\n")}, nil
}

// ── grep ─────────────────────────────────────────────────────────────────────

type grepTool struct{ Base }

// NewGrep returns the grep tool: regex content search across files.
func NewGrep() *grepTool {
	return &grepTool{Base{
		ToolName: "grep",
		ToolDescription: "Search file contents by Go regular expression. Returns matching " +
			"'path:line: text' rows. Optionally restrict to files matching an include glob.",
		ReadOnly:        true,
		ConcurrencySafe: true,
		ToolSchema: obj(props{
			"pattern": strProp("Regular expression (Go/RE2 syntax)."),
			"path":    strProp("Base directory to search (optional; defaults to the root)."),
			"include": strProp("Only search files matching this glob, e.g. '*.go' (optional)."),
		}, "pattern"),
	}}
}

func (grepTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	pattern := strArg(input, "pattern")
	if strings.TrimSpace(pattern) == "" {
		return errResult("missing required argument 'pattern'")
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return errResult("invalid pattern: %v", err)
	}
	base := strArg(input, "path")
	if strings.TrimSpace(base) == "" {
		base = "."
	}
	absBase, err := resolveInCwd(ec.Cwd, base)
	if err != nil {
		return errResult("%v", err)
	}
	var includeRe *regexp.Regexp
	if inc := strArg(input, "include"); strings.TrimSpace(inc) != "" {
		includeRe, err = globToRegexp(inc)
		if err != nil {
			return errResult("invalid include: %v", err)
		}
	}
	var (
		out      strings.Builder
		nMatches int
		stopped  bool
	)
	walk(absBase, func(rel string, isDir bool) bool {
		if isDir {
			return true
		}
		if includeRe != nil && !includeRe.MatchString(rel) && !includeRe.MatchString(filepath.Base(rel)) {
			return true
		}
		full := filepath.Join(absBase, rel)
		if info, e := os.Stat(full); e != nil || info.Size() > maxScanFileBytes {
			return true
		}
		f, e := os.Open(full)
		if e != nil {
			return true
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		ln := 0
		for sc.Scan() {
			ln++
			line := sc.Text()
			if strings.IndexByte(line, 0) >= 0 {
				return true // binary
			}
			if re.MatchString(line) {
				if len(line) > maxLineLen {
					line = line[:maxLineLen] + "…"
				}
				fmt.Fprintf(&out, "%s:%d: %s\n", rel, ln, line)
				nMatches++
				if nMatches >= maxGrepMatches {
					stopped = true
					return false
				}
			}
		}
		return true
	})
	if nMatches == 0 {
		return Result{Content: "(no matches)"}, nil
	}
	if stopped {
		fmt.Fprintf(&out, "… (truncated at %d matches)\n", maxGrepMatches)
	}
	return Result{Content: out.String()}, nil
}

// ── write ────────────────────────────────────────────────────────────────────

type writeTool struct{ Base }

// NewWrite returns the write tool: create or overwrite a file.
func NewWrite() *writeTool {
	return &writeTool{Base{
		ToolName:        "write",
		ToolDescription: "Create or overwrite a file in the working copy with the given content (parent directories are created).",
		// Mutating: not read-only, not concurrency-safe (fail-closed).
		ToolSchema: obj(props{
			"path":    strProp("File path within the working copy."),
			"content": strProp("Full file content to write."),
		}, "path", "content"),
	}}
}

func (writeTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	abs, err := resolveInCwd(ec.Cwd, strArg(input, "path"))
	if err != nil {
		return errResult("%v", err)
	}
	content := strArg(input, "content")
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return errResult("%v", err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return errResult("%v", err)
	}
	n := strings.Count(content, "\n")
	if len(content) > 0 && !strings.HasSuffix(content, "\n") {
		n++
	}
	return Result{Content: fmt.Sprintf("Wrote %d line(s) to %s", n, strArg(input, "path"))}, nil
}

// ── edit ─────────────────────────────────────────────────────────────────────

type editTool struct{ Base }

// NewEdit returns the edit tool: exact string replacement.
func NewEdit() *editTool {
	return &editTool{Base{
		ToolName: "edit",
		ToolDescription: "Replace an exact string in a file. By default old_string must occur " +
			"exactly once (include surrounding context to disambiguate); set replace_all to " +
			"replace every occurrence.",
		// Mutating: not read-only, not concurrency-safe.
		ToolSchema: obj(props{
			"path":        strProp("File path within the working copy."),
			"old_string":  strProp("Exact text to replace (must be unique unless replace_all)."),
			"new_string":  strProp("Replacement text."),
			"replace_all": boolProp("Replace every occurrence instead of requiring uniqueness (optional)."),
		}, "path", "old_string", "new_string"),
	}}
}

func (editTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	abs, err := resolveInCwd(ec.Cwd, strArg(input, "path"))
	if err != nil {
		return errResult("%v", err)
	}
	oldStr := strArg(input, "old_string")
	newStr := strArg(input, "new_string")
	if oldStr == "" {
		return errResult("missing required argument 'old_string'")
	}
	if oldStr == newStr {
		return errResult("old_string and new_string are identical")
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return errResult("%v", err)
	}
	content := string(data)
	count := strings.Count(content, oldStr)
	if count == 0 {
		return errResult("old_string not found in %s", strArg(input, "path"))
	}
	replaceAll, _ := input["replace_all"].(bool)
	if !replaceAll && count > 1 {
		return errResult("old_string occurs %d times in %s; add context or set replace_all", count, strArg(input, "path"))
	}
	var updated string
	if replaceAll {
		updated = strings.ReplaceAll(content, oldStr, newStr)
	} else {
		updated = strings.Replace(content, oldStr, newStr, 1)
	}
	if err := os.WriteFile(abs, []byte(updated), 0o644); err != nil {
		return errResult("%v", err)
	}
	return Result{Content: fmt.Sprintf("Replaced %d occurrence(s) in %s", count, strArg(input, "path"))}, nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

// walk visits files/dirs under base, calling fn with the path RELATIVE to base
// and whether it's a directory. Returning false from fn stops the walk. The
// .git directory is skipped. Symlinks are skipped entirely (WalkDir never
// descends into them, and we drop symlinked files too) so glob/grep can never
// surface or read a path that resolves outside the working copy.
func walk(base string, fn func(rel string, isDir bool) bool) {
	_ = filepath.WalkDir(base, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // skip unreadable entries
		}
		rel, rerr := filepath.Rel(base, p)
		if rerr != nil || rel == "." {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil // skip symlinks (potential escape)
		}
		if !fn(filepath.ToSlash(rel), d.IsDir()) {
			return filepath.SkipAll
		}
		return nil
	})
}

// globToRegexp converts a glob (with **, *, ?) into an anchored RE2 regexp that
// matches a slash-separated relative path.
func globToRegexp(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch c {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				i++
				// `**/` matches zero or more path segments; bare `**` matches anything.
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					i++
					b.WriteString("(?:[^/]*/)*")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '.', '+', '(', ')', '|', '^', '$', '{', '}', '[', ']', '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

// ── tiny JSON-Schema builders ────────────────────────────────────────────────

type props map[string]any

func obj(p props, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": map[string]any(p)}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

func strProp(desc string) map[string]any  { return map[string]any{"type": "string", "description": desc} }
func intProp(desc string) map[string]any  { return map[string]any{"type": "integer", "description": desc} }
func boolProp(desc string) map[string]any { return map[string]any{"type": "boolean", "description": desc} }
