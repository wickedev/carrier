package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// notebookEditTool edits a Jupyter notebook (.ipynb) cell by index. Mutating.
type notebookEditTool struct{ Base }

// NewNotebookEdit returns the notebook_edit tool.
func NewNotebookEdit() *notebookEditTool {
	return &notebookEditTool{Base{
		ToolName: "notebook_edit",
		ToolDescription: "Edit a Jupyter notebook (.ipynb): replace, insert, or delete a cell by " +
			"0-based index.",
		// Niche (Jupyter-only): Deferred keeps it out of the default tool list;
		// the model recovers it via tool_search when it needs to edit a notebook.
		Expose: Deferred,
		ToolSchema: obj(props{
			"path":       strProp("Notebook (.ipynb) path within the working copy."),
			"cell_index": intProp("0-based cell index (replace/delete target, or insert position)."),
			"new_source": strProp("Cell source text (for replace/insert)."),
			"edit_mode": map[string]any{
				"type":        "string",
				"enum":        []string{"replace", "insert", "delete"},
				"description": "Edit mode (default replace).",
			},
			"cell_type": map[string]any{
				"type":        "string",
				"enum":        []string{"code", "markdown"},
				"description": "Cell type for insert (default code).",
			},
		}, "path"),
	}}
}

func (notebookEditTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	display := strArg(input, "path")
	if !strings.HasSuffix(display, ".ipynb") {
		return errResult("path must be a .ipynb notebook")
	}
	abs, err := resolveInCwd(ec.Cwd, display)
	if err != nil {
		return errResult("%v", err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return errResult("%v", err)
	}
	var nb map[string]any
	if err := json.Unmarshal(data, &nb); err != nil {
		return errResult("invalid notebook JSON: %v", err)
	}
	cells, _ := nb["cells"].([]any)

	idx, _ := intArg(input, "cell_index")
	mode := strArg(input, "edit_mode")
	if mode == "" {
		mode = "replace"
	}
	source := strArg(input, "new_source")

	switch mode {
	case "replace":
		if idx < 0 || idx >= len(cells) {
			return errResult("cell_index %d out of range (0..%d)", idx, len(cells)-1)
		}
		cell, _ := cells[idx].(map[string]any)
		if cell == nil {
			return errResult("cell %d is malformed", idx)
		}
		cell["source"] = sourceLines(source)
	case "insert":
		if idx < 0 || idx > len(cells) {
			return errResult("insert index %d out of range (0..%d)", idx, len(cells))
		}
		ct := strArg(input, "cell_type")
		if ct != "markdown" {
			ct = "code"
		}
		newCell := map[string]any{"cell_type": ct, "metadata": map[string]any{}, "source": sourceLines(source)}
		if ct == "code" {
			newCell["outputs"] = []any{}
			newCell["execution_count"] = nil
		}
		cells = append(cells[:idx], append([]any{newCell}, cells[idx:]...)...)
		nb["cells"] = cells
	case "delete":
		if idx < 0 || idx >= len(cells) {
			return errResult("cell_index %d out of range (0..%d)", idx, len(cells)-1)
		}
		cells = append(cells[:idx], cells[idx+1:]...)
		nb["cells"] = cells
	default:
		return errResult("unknown edit_mode %q", mode)
	}

	out, err := json.MarshalIndent(nb, "", " ")
	if err != nil {
		return errResult("%v", err)
	}
	if err := os.WriteFile(abs, append(out, '\n'), 0o644); err != nil {
		return errResult("%v", err)
	}
	return Result{Content: fmt.Sprintf("%s cell %d in %s", mode, idx, display)}, nil
}

// sourceLines splits text into nbformat's per-line source array (newlines kept).
func sourceLines(s string) []any {
	if s == "" {
		return []any{}
	}
	parts := strings.SplitAfter(s, "\n")
	out := make([]any, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}
