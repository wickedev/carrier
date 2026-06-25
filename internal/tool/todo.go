package tool

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// TodoStore is the per-session task list shared by the todo_write and todo_read
// tools. newSession builds a fresh store per Flight, so the list never leaks
// across sessions.
type TodoStore struct {
	mu    sync.Mutex
	items []todoItem
}

type todoItem struct {
	content string
	status  string // pending | in_progress | completed
}

// NewTodoStore returns an empty task list for one session.
func NewTodoStore() *TodoStore { return &TodoStore{} }

func (s *TodoStore) set(items []todoItem) {
	s.mu.Lock()
	s.items = items
	s.mu.Unlock()
}

func (s *TodoStore) render() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return renderTodos(s.items)
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

// ── todo_write ───────────────────────────────────────────────────────────────

type todoWriteTool struct {
	Base
	store *TodoStore
}

// NewTodoWrite returns the task-list writer over store. It is read-only —
// updating a plan has no effect on the world — so it stays available in plan
// mode and is auto-allowed.
func NewTodoWrite(store *TodoStore) *todoWriteTool {
	return &todoWriteTool{
		store: store,
		Base: Base{
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
		},
	}
}

func (t *todoWriteTool) Exec(_ context.Context, input map[string]any, _ ExecContext) (Result, error) {
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
	t.store.set(items)
	return Result{Content: t.store.render()}, nil
}

// ── todo_read ────────────────────────────────────────────────────────────────

type todoReadTool struct {
	Base
	store *TodoStore
}

// NewTodoRead returns the task-list reader over store.
func NewTodoRead(store *TodoStore) *todoReadTool {
	return &todoReadTool{
		store: store,
		Base: Base{
			ToolName:        "todo_read",
			ToolDescription: "Return the session's current task checklist.",
			ReadOnly:        true,
			ConcurrencySafe: true,
			ToolSchema:      obj(props{}),
		},
	}
}

func (t *todoReadTool) Exec(_ context.Context, _ map[string]any, _ ExecContext) (Result, error) {
	return Result{Content: t.store.render()}, nil
}
