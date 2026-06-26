package tool

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/wickedev/carrier/internal/lsp"
)

// lspTool surfaces language-server intelligence for a file: diagnostics
// (errors/warnings) by default, or hover info when a line is given. Read-only.
type lspTool struct{ Base }

// NewLSP returns the lsp tool.
func NewLSP() *lspTool {
	return &lspTool{Base{
		ToolName: "lsp",
		ToolDescription: "Get language-server intelligence for a source file: diagnostics " +
			"(errors and warnings) by default, or hover info (types/docs) when you pass a 0-based " +
			"line and character. Supports Go, TypeScript/JavaScript, Python, Rust, Ruby, and Java " +
			"when the matching language server is installed.",
		ReadOnly: true,
		ToolSchema: obj(props{
			"path":      strProp("Path to the source file, within the working directory."),
			"line":      intProp("Optional 0-based line for hover (requires character)."),
			"character": intProp("Optional 0-based character for hover (requires line)."),
		}, "path"),
	}}
}

func (lspTool) Exec(ctx context.Context, input map[string]any, ec ExecContext) (Result, error) {
	rel := strArg(input, "path")
	abs, err := resolveInCwd(ec.Cwd, rel)
	if err != nil {
		return errResult("%v", err)
	}
	if ec.LSP == nil {
		return errResult("language-server support is not available in this context")
	}
	if !lsp.Supported(abs) {
		return errResult("no language server is configured for this file type")
	}
	text, err := os.ReadFile(abs)
	if err != nil {
		return errResult("%v", err)
	}

	// Hover mode when a line is supplied.
	if line, ok := intArg(input, "line"); ok {
		char, _ := intArg(input, "character")
		hov, err := ec.LSP.Hover(ctx, abs, string(text), line, char)
		if err != nil {
			return errResult("%v", err)
		}
		if hov == "" {
			return Result{Content: fmt.Sprintf("No hover info at %s:%d:%d.", rel, line, char)}, nil
		}
		return Result{Content: hov}, nil
	}

	diags, received, err := ec.LSP.Diagnostics(ctx, abs, string(text))
	if err != nil {
		return errResult("%v", err)
	}
	if !received {
		return Result{Content: fmt.Sprintf(
			"No diagnostics returned for %s in time — the language server may still be analyzing or be slow to start. Try again.", rel)}, nil
	}
	return Result{Content: formatDiagnostics(rel, diags)}, nil
}

// formatDiagnostics renders diagnostics as one line each, sorted by position.
func formatDiagnostics(path string, diags []lsp.Diagnostic) string {
	if len(diags) == 0 {
		return fmt.Sprintf("No diagnostics for %s.", path)
	}
	sorted := append([]lsp.Diagnostic(nil), diags...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Line != sorted[j].Line {
			return sorted[i].Line < sorted[j].Line
		}
		return sorted[i].Char < sorted[j].Char
	})
	var b strings.Builder
	fmt.Fprintf(&b, "%d diagnostic(s) for %s:\n", len(sorted), path)
	for _, d := range sorted {
		src := d.Source
		if src != "" {
			src = " [" + src + "]"
		}
		// LSP positions are 0-based; present 1-based for humans.
		fmt.Fprintf(&b, "%s:%d:%d: %s: %s%s\n",
			path, d.Line+1, d.Char+1, severityLabel(d.Severity), d.Message, src)
	}
	return strings.TrimRight(b.String(), "\n")
}

func severityLabel(s int) string {
	switch s {
	case lsp.SeverityError:
		return "error"
	case lsp.SeverityWarning:
		return "warning"
	case lsp.SeverityInfo:
		return "info"
	case lsp.SeverityHint:
		return "hint"
	default:
		return "diagnostic"
	}
}
