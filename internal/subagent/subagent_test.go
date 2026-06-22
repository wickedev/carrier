package subagent

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tool"
)

// fakeEngine is a minimal Engine that emits a single assistant text event and
// returns a Done step. An optional probe records the peak number of concurrent
// in-flight RunStep calls so tests can assert the concurrency bound.
type fakeEngine struct {
	text  string
	delay time.Duration

	active int64 // current in-flight RunStep count
	peak   int64 // high-water mark of active
}

func (e *fakeEngine) Name() string { return "fake" }

func (e *fakeEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	n := atomic.AddInt64(&e.active, 1)
	for {
		p := atomic.LoadInt64(&e.peak)
		if n <= p || atomic.CompareAndSwapInt64(&e.peak, p, n) {
			break
		}
	}
	defer atomic.AddInt64(&e.active, -1)

	if e.delay > 0 {
		select {
		case <-time.After(e.delay):
		case <-ctx.Done():
			return agent.StepResult{}, ctx.Err()
		}
	}

	if in.OnEvent != nil {
		in.OnEvent(agent.StreamEvent{Kind: agent.EvText, Text: e.text})
	}
	return agent.StepResult{Text: e.text, Done: true}, nil
}

func newStore(t *testing.T) store.Store {
	t.Helper()
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	return st
}

func TestSpawnReturnsSummary(t *testing.T) {
	t.Parallel()
	sp := New(SpawnerConfig{
		Engine:        &fakeEngine{text: "child-done"},
		Store:         newStore(t),
		Tools:         tool.NewRegistry(),
		MaxConcurrent: 2,
		MaxDepth:      3,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	got, err := sp.Spawn(ctx, "parent", "do the thing", 0)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if got != "child-done" {
		t.Fatalf("summary = %q, want %q", got, "child-done")
	}
}

func TestSpawnDepthBound(t *testing.T) {
	t.Parallel()
	sp := New(SpawnerConfig{
		Engine:   &fakeEngine{text: "child-done"},
		Store:    newStore(t),
		Tools:    tool.NewRegistry(),
		MaxDepth: 2,
	})

	ctx := context.Background()

	// depth < max is allowed.
	if _, err := sp.Spawn(ctx, "p", "ok", 1); err != nil {
		t.Fatalf("Spawn at depth 1 (max 2): unexpected error %v", err)
	}
	// depth >= max errors.
	if _, err := sp.Spawn(ctx, "p", "blocked", 2); err == nil {
		t.Fatalf("Spawn at depth 2 (max 2): expected recursion-bound error, got nil")
	}
	if _, err := sp.Spawn(ctx, "p", "blocked", 3); err == nil {
		t.Fatalf("Spawn at depth 3 (max 2): expected recursion-bound error, got nil")
	}
}

func TestTaskToolExec(t *testing.T) {
	t.Parallel()
	sp := New(SpawnerConfig{
		Engine:        &fakeEngine{text: "tool-child-done"},
		Store:         newStore(t),
		Tools:         tool.NewRegistry(),
		MaxConcurrent: 2,
		MaxDepth:      3,
	})
	tt := NewTaskTool(sp)

	if tt.Name() != "task" {
		t.Fatalf("tool name = %q, want %q", tt.Name(), "task")
	}
	if !tt.IsConcurrencySafe(nil) {
		t.Fatalf("task tool must be concurrency-safe for parallel fan-out")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := tt.Exec(ctx, map[string]any{"prompt": "sub work"}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.IsError {
		t.Fatalf("Exec returned error result: %q", res.Content)
	}
	if res.Content != "tool-child-done" {
		t.Fatalf("Exec content = %q, want %q", res.Content, "tool-child-done")
	}
}

func TestTaskToolEmptyPrompt(t *testing.T) {
	t.Parallel()
	sp := New(SpawnerConfig{
		Engine: &fakeEngine{text: "x"},
		Store:  newStore(t),
		Tools:  tool.NewRegistry(),
	})
	tt := NewTaskTool(sp)
	res, err := tt.Exec(context.Background(), map[string]any{}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !res.IsError {
		t.Fatalf("empty prompt should yield an error result, got %+v", res)
	}
}

func TestTaskToolDepthAccumulates(t *testing.T) {
	t.Parallel()
	// MaxDepth 1 means depth >= 1 errors. The task tool at depth 0 spawns a
	// child at depth 0 (allowed), but a context already at depth 1 must be
	// rejected by the Spawner.
	sp := New(SpawnerConfig{
		Engine:   &fakeEngine{text: "ok"},
		Store:    newStore(t),
		Tools:    tool.NewRegistry(),
		MaxDepth: 1,
	})
	tt := NewTaskTool(sp)

	// A context carrying depth 1 should be blocked (1 >= MaxDepth 1).
	ctx := WithDepth(context.Background(), 1)
	res, err := tt.Exec(ctx, map[string]any{"prompt": "deep"}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected depth-bound error result at depth 1 (max 1), got %+v", res)
	}
}

func TestBoundedConcurrency(t *testing.T) {
	t.Parallel()
	const maxConc = 3
	const fanout = 12

	eng := &fakeEngine{text: "child-done", delay: 30 * time.Millisecond}
	sp := New(SpawnerConfig{
		Engine:        eng,
		Store:         newStore(t),
		Tools:         tool.NewRegistry(),
		MaxConcurrent: maxConc,
		MaxDepth:      3,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	errc := make(chan error, fanout)
	for i := 0; i < fanout; i++ {
		go func() {
			_, err := sp.Spawn(ctx, "parent", "work", 0)
			errc <- err
		}()
	}
	for i := 0; i < fanout; i++ {
		if err := <-errc; err != nil {
			t.Fatalf("Spawn[%d]: %v", i, err)
		}
	}

	if peak := atomic.LoadInt64(&eng.peak); peak > maxConc {
		t.Fatalf("peak concurrent children = %d, exceeds MaxConcurrent %d", peak, maxConc)
	}
}

func TestDeriveCeilingPassthrough(t *testing.T) {
	t.Parallel()
	if got := DeriveCeiling(nil); got != nil {
		t.Fatalf("DeriveCeiling(nil) = %v, want nil passthrough", got)
	}
}
