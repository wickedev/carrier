package tool

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// todoTool is the session task list. It is stateful and per-session: newSession
// builds a fresh registry (and thus a fresh todoTool) for each Flight, so the
// list never leaks across sessions. It is marked read-only — updating a plan has
// no effect on the world — so it stays available in plan mode and is auto-allowed.
type todoTool struct {
	Base
	mu    sync.Mutex
	items []todoItem
}

type todoItem struct {
	content string
	status  string // pending | in_progress | completed
}

// NewTodo returns a fresh, empty task-list tool for one session.
func NewTodo() *todoTool {
	return &todoTool{Base: Base{
		ToolName: "todo_write",
		ToolDescription: "Maintain the session's task checklist. Pass the FULL list each call (it " +
			"replaces the previous one); each item has content and a status of pending, in_progress, " +
			"or completed. Use it to plan and track multi-step work.",
		ReadOnly: true,
		ToolSchema: obj(props{
			"todos": arrProp("The full task list (replaces the previous one).", obj(props{
				"content": strProp("Task description."),
				"status": map[string]any{
					"type":        "string",
					"enum":        []string{"pending", "in_progress", "completed"},
					"description": "Task status.",
				},
			}, "content", "status")),
		}, "todos"),
	}}
}

func (t *todoTool) Exec(_ context.Context, input map[string]any, _ ExecContext) (Result, error) {
	raw, ok := input["todos"].([]any)
	if !ok {
		return errResult("missing required argument 'todos'")
	}
	items := make([]todoItem, 0, len(raw))
	for i, e := range raw {
		m, _ := e.(map[string]any)
		content, _ := m["content"].(string)
		if strings.TrimSpace(content) == "" {
			return errResult("todo %d: missing content", i+1)
		}
		status, _ := m["status"].(string)
		switch status {
		case "pending", "in_progress", "completed":
		default:
			status = "pending"
		}
		items = append(items, todoItem{content: content, status: status})
	}
	t.mu.Lock()
	t.items = items
	t.mu.Unlock()
	return Result{Content: renderTodos(items)}, nil
}

var todoMark = map[string]string{"completed": "[x]", "in_progress": "[~]", "pending": "[ ]"}

func renderTodos(items []todoItem) string {
	if len(items) == 0 {
		return "(no tasks)"
	}
	var b strings.Builder
	for _, it := range items {
		fmt.Fprintf(&b, "%s %s\n", todoMark[it.status], it.content)
	}
	return strings.TrimRight(b.String(), "\n")
}
