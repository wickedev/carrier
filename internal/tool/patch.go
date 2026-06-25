package tool

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// applyPatchTool applies a set of create/edit/delete operations across the
// working copy in one call. It is validated in full first (paths confined, edits
// matched, creates/deletes checked) and only then written, so a bad operation
// leaves every file untouched. Mutating: not read-only, not concurrency-safe.
type applyPatchTool struct{ Base }

// NewApplyPatch returns the apply_patch tool.
func NewApplyPatch() *applyPatchTool {
	return &applyPatchTool{Base{
		ToolName: "apply_patch",
		ToolDescription: "Apply file operations across the working copy ATOMICALLY: create, edit " +
			"(exact-string replacements), or delete files. Every operation is validated first; if any " +
			"fails, nothing is written. Use this for coordinated multi-file changes.",
		ToolSchema: obj(props{
			"operations": arrProp("Operations to apply in order.", obj(props{
				"type": map[string]any{
					"type":        "string",
					"enum":        []string{"create", "edit", "delete"},
					"description": "Operation kind.",
				},
				"path":    strProp("File path within the working copy."),
				"content": strProp("Full file content (for create)."),
				"edits": arrProp("Exact replacements (for edit).", obj(props{
					"old_string":  strProp("Exact text to replace."),
					"new_string":  strProp("Replacement text."),
					"replace_all": boolProp("Replace every occurrence (optional)."),
				}, "old_string", "new_string")),
			}, "type", "path")),
		}, "operations"),
	}}
}

type plannedWrite struct {
	abs     string
	display string
	content string
	delete  bool
	create  bool
}

func (applyPatchTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	raw, ok := input["operations"].([]any)
	if !ok || len(raw) == 0 {
		return errResult("missing required argument 'operations'")
	}
	planned := make([]plannedWrite, 0, len(raw))
	// PHASE 1 — validate everything and compute the resulting content in memory.
	for i, o := range raw {
		m, _ := o.(map[string]any)
		opType, _ := m["type"].(string)
		display, _ := m["path"].(string)
		abs, err := resolveInCwd(ec.Cwd, display)
		if err != nil {
			return errResult("operation %d: %v", i+1, err)
		}
		switch opType {
		case "create":
			if _, err := os.Lstat(abs); err == nil {
				return errResult("operation %d: %s already exists (use edit)", i+1, display)
			}
			content, _ := m["content"].(string)
			planned = append(planned, plannedWrite{abs: abs, display: display, content: content, create: true})
		case "edit":
			data, err := os.ReadFile(abs)
			if err != nil {
				return errResult("operation %d: %v", i+1, err)
			}
			content, err := applyEdits(string(data), m["edits"])
			if err != nil {
				return errResult("operation %d (%s): %v", i+1, display, err)
			}
			planned = append(planned, plannedWrite{abs: abs, display: display, content: content})
		case "delete":
			if _, err := os.Stat(abs); err != nil {
				return errResult("operation %d: %v", i+1, err)
			}
			planned = append(planned, plannedWrite{abs: abs, display: display, delete: true})
		default:
			return errResult("operation %d: unknown type %q", i+1, opType)
		}
	}
	// PHASE 2 — apply (validation already passed, so this rarely fails).
	var summary []string
	for _, p := range planned {
		if p.delete {
			if err := os.Remove(p.abs); err != nil {
				return errResult("%v", err)
			}
			summary = append(summary, "deleted "+p.display)
			continue
		}
		if p.create {
			if err := os.MkdirAll(filepath.Dir(p.abs), 0o755); err != nil {
				return errResult("%v", err)
			}
		}
		if err := os.WriteFile(p.abs, []byte(p.content), 0o644); err != nil {
			return errResult("%v", err)
		}
		if p.create {
			summary = append(summary, "created "+p.display)
		} else {
			summary = append(summary, "edited "+p.display)
		}
	}
	return Result{Content: fmt.Sprintf("Applied %d operation(s): %s", len(planned), strings.Join(summary, ", "))}, nil
}

// applyEdits runs the edit list against content in memory (each old_string must
// match; unique unless its replace_all is set) and returns the new content.
func applyEdits(content string, editsRaw any) (string, error) {
	edits, ok := editsRaw.([]any)
	if !ok || len(edits) == 0 {
		return "", fmt.Errorf("missing 'edits'")
	}
	for i, e := range edits {
		m, _ := e.(map[string]any)
		oldStr, _ := m["old_string"].(string)
		newStr, _ := m["new_string"].(string)
		if oldStr == "" {
			return "", fmt.Errorf("edit %d: missing old_string", i+1)
		}
		cnt := strings.Count(content, oldStr)
		if cnt == 0 {
			return "", fmt.Errorf("edit %d: old_string not found", i+1)
		}
		replaceAll, _ := m["replace_all"].(bool)
		if !replaceAll && cnt > 1 {
			return "", fmt.Errorf("edit %d: old_string occurs %d times; add context or set replace_all", i+1, cnt)
		}
		if replaceAll {
			content = strings.ReplaceAll(content, oldStr, newStr)
		} else {
			content = strings.Replace(content, oldStr, newStr, 1)
		}
	}
	return content, nil
}
