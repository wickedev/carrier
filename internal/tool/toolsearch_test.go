package tool

import (
	"context"
	"strings"
	"testing"
)

func deferredFake(name, desc string) *fakeTool {
	return &fakeTool{
		Base: Base{ToolName: name, ToolDescription: desc, Expose: Deferred},
		run:  func(context.Context, map[string]any, ExecContext) (Result, error) { return Result{}, nil },
	}
}

func containsTool(ts []Tool, name string) bool {
	for _, t := range ts {
		if t.Name() == name {
			return true
		}
	}
	return false
}

func TestToolSearchRevealsMatchingDeferred(t *testing.T) {
	reg := NewRegistry()
	reg.Register(deferredFake("notebook_edit", "Edit a Jupyter notebook (.ipynb) cell by index"))
	reg.Register(deferredFake("image_convert", "Convert and resize image files"))
	reg.Register(&fakeTool{Base: Base{ToolName: "read", ToolDescription: "read a file"}}) // Direct
	ts := NewToolSearch(reg)

	// Deferred tools are hidden from the default list; Direct ones are visible.
	if containsTool(reg.Visible(), "notebook_edit") {
		t.Fatal("deferred tool should not be visible before a search")
	}
	if !containsTool(reg.Visible(), "read") {
		t.Fatal("direct tool should always be visible")
	}

	res, err := ts.Exec(context.Background(), map[string]any{"query": "edit a jupyter notebook"}, ExecContext{})
	if err != nil || res.IsError {
		t.Fatalf("tool_search: err=%v res=%s", err, res.Content)
	}
	if !strings.Contains(res.Content, "notebook_edit") {
		t.Fatalf("expected notebook_edit surfaced: %q", res.Content)
	}

	// The matched tool is now visible; the unrelated deferred tool is not.
	if !containsTool(reg.Visible(), "notebook_edit") {
		t.Fatal("notebook_edit should be visible after being revealed")
	}
	if containsTool(reg.Visible(), "image_convert") {
		t.Fatal("an unrelated deferred tool must not be revealed")
	}
}

func TestToolSearchNoMatch(t *testing.T) {
	reg := NewRegistry()
	reg.Register(deferredFake("notebook_edit", "Edit a Jupyter notebook"))
	res, err := NewToolSearch(reg).Exec(context.Background(),
		map[string]any{"query": "qwerty nonexistent capability"}, ExecContext{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.IsError || !strings.Contains(res.Content, "No additional tools") {
		t.Fatalf("expected a no-match message, got %q", res.Content)
	}
	if containsTool(reg.Visible(), "notebook_edit") {
		t.Fatal("a no-match search must not reveal anything")
	}
}

func TestToolSearchMissingQuery(t *testing.T) {
	res, _ := NewToolSearch(NewRegistry()).Exec(context.Background(), map[string]any{}, ExecContext{})
	if !res.IsError {
		t.Fatal("expected an error for a missing query")
	}
}

func TestRegistryRevealRules(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeTool{Base: Base{ToolName: "read"}}) // Direct
	if reg.Reveal("read") {
		t.Error("a Direct tool cannot be revealed (it's already visible)")
	}
	if reg.Reveal("ghost") {
		t.Error("an unknown tool cannot be revealed")
	}
	reg.Register(deferredFake("notebook_edit", "Edit a Jupyter notebook"))
	if !reg.Reveal("notebook_edit") {
		t.Error("a Deferred tool should be revealable")
	}
	if !containsTool(reg.Deferred(), "notebook_edit") {
		t.Error("Deferred() should list the deferred tool")
	}
}

func TestSearchToolsRanksByTermOverlap(t *testing.T) {
	pool := []Tool{
		deferredFake("notebook_edit", "edit a jupyter notebook by cell"),
		deferredFake("image_convert", "resize and convert images"),
	}
	got := searchTools(pool, "edit notebook cell", 5)
	if len(got) != 1 || got[0].Name() != "notebook_edit" {
		t.Fatalf("expected only notebook_edit, got %+v", got)
	}
	// max_results caps the output.
	pool = append(pool, deferredFake("notebook_run", "run a jupyter notebook cell"))
	if n := len(searchTools(pool, "notebook cell", 1)); n != 1 {
		t.Fatalf("max_results not honored: got %d", n)
	}
}
