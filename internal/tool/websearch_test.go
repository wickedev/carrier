package tool

import (
	"context"
	"testing"
)

func TestWebSearchIsNativeReadOnlyConcurrencySafe(t *testing.T) {
	ws := NewWebSearch()
	if ws.Name() != "web_search" {
		t.Fatalf("name = %q", ws.Name())
	}
	if ws.Native() != "web_search" {
		t.Fatalf("Native() = %q, want web_search", ws.Native())
	}
	if !ws.IsReadOnly(nil) {
		t.Error("web_search should be read-only (usable in plan mode)")
	}
	if !ws.IsConcurrencySafe(nil) {
		t.Error("web_search should be concurrency-safe")
	}
	// It satisfies the marker interface the Flight uses to detect native tools.
	var _ interface{ Native() string } = ws
}

func TestWebSearchExecIsNotLocallyDispatched(t *testing.T) {
	res, err := NewWebSearch().Exec(context.Background(), map[string]any{"query": "x"}, ExecContext{})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.IsError {
		t.Fatal("web_search.Exec should report an error (it is provider-hosted, not local)")
	}
}
