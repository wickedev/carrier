package tool

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/bay"
)

// fakeTool is a configurable Tool for dispatch tests.
type fakeTool struct {
	Base
	run func(ctx context.Context, input map[string]any, ec ExecContext) (Result, error)
}

func (f *fakeTool) Exec(ctx context.Context, input map[string]any, ec ExecContext) (Result, error) {
	return f.run(ctx, input, ec)
}

func newFake(name string, safe bool, run func(context.Context, map[string]any, ExecContext) (Result, error)) *fakeTool {
	return &fakeTool{
		Base: Base{ToolName: name, ConcurrencySafe: safe},
		run:  run,
	}
}

func TestDispatchPreservesOrderAndIDs(t *testing.T) {
	reg := NewRegistry()
	reg.Register(newFake("echo", false, func(_ context.Context, in map[string]any, _ ExecContext) (Result, error) {
		return Result{Content: in["v"].(string)}, nil
	}))
	calls := []agent.ToolCall{
		{ID: "a", Name: "echo", Input: map[string]any{"v": "1"}},
		{ID: "b", Name: "echo", Input: map[string]any{"v": "2"}},
		{ID: "c", Name: "echo", Input: map[string]any{"v": "3"}},
	}
	res := Dispatch(context.Background(), calls, reg, ExecContext{}, 4)
	for i, want := range []struct{ id, content string }{{"a", "1"}, {"b", "2"}, {"c", "3"}} {
		if res[i].ToolCallID != want.id || res[i].Content != want.content {
			t.Fatalf("res[%d] = %+v, want id=%s content=%s", i, res[i], want.id, want.content)
		}
	}
}

func TestDispatchUnknownToolIsErrorResult(t *testing.T) {
	reg := NewRegistry()
	res := Dispatch(context.Background(), []agent.ToolCall{{ID: "x", Name: "nope"}}, reg, ExecContext{}, 4)
	if !res[0].IsError || res[0].ToolCallID != "x" {
		t.Fatalf("expected error result for unknown tool, got %+v", res[0])
	}
}

func TestDispatchExecErrorBecomesResult(t *testing.T) {
	reg := NewRegistry()
	reg.Register(newFake("boom", false, func(context.Context, map[string]any, ExecContext) (Result, error) {
		return Result{}, fmt.Errorf("kaboom")
	}))
	res := Dispatch(context.Background(), []agent.ToolCall{{ID: "x", Name: "boom"}}, reg, ExecContext{}, 4)
	if !res[0].IsError {
		t.Fatalf("expected error result, got %+v", res[0])
	}
}

// concurrencyProbe tracks the maximum number of simultaneous executions.
type concurrencyProbe struct {
	active int32
	max    int32
}

func (p *concurrencyProbe) enter() {
	cur := atomic.AddInt32(&p.active, 1)
	for {
		m := atomic.LoadInt32(&p.max)
		if cur <= m || atomic.CompareAndSwapInt32(&p.max, m, cur) {
			break
		}
	}
}
func (p *concurrencyProbe) leave() { atomic.AddInt32(&p.active, -1) }

func TestDispatchSafeBatchRunsInParallel(t *testing.T) {
	var probe concurrencyProbe
	reg := NewRegistry()
	reg.Register(newFake("read", true, func(context.Context, map[string]any, ExecContext) (Result, error) {
		probe.enter()
		time.Sleep(20 * time.Millisecond)
		probe.leave()
		return Result{Content: "ok"}, nil
	}))
	calls := make([]agent.ToolCall, 4)
	for i := range calls {
		calls[i] = agent.ToolCall{ID: fmt.Sprintf("r%d", i), Name: "read"}
	}
	Dispatch(context.Background(), calls, reg, ExecContext{}, 4)
	if atomic.LoadInt32(&probe.max) < 2 {
		t.Fatalf("expected concurrency-safe batch to run in parallel, max observed = %d", probe.max)
	}
}

func TestDispatchUnsafeBatchSerializes(t *testing.T) {
	var probe concurrencyProbe
	reg := NewRegistry()
	reg.Register(newFake("write", false, func(context.Context, map[string]any, ExecContext) (Result, error) {
		probe.enter()
		time.Sleep(10 * time.Millisecond)
		probe.leave()
		return Result{Content: "ok"}, nil
	}))
	calls := make([]agent.ToolCall, 4)
	for i := range calls {
		calls[i] = agent.ToolCall{ID: fmt.Sprintf("w%d", i), Name: "write"}
	}
	Dispatch(context.Background(), calls, reg, ExecContext{}, 4)
	if atomic.LoadInt32(&probe.max) != 1 {
		t.Fatalf("expected unsafe calls to serialize, max observed = %d", probe.max)
	}
}

func TestRegistryFirstWinsAndVisible(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeTool{Base: Base{ToolName: "dup", ToolDescription: "first"}})
	reg.Register(&fakeTool{Base: Base{ToolName: "dup", ToolDescription: "second"}})
	got, _ := reg.Get("dup")
	if got.Description() != "first" {
		t.Fatalf("first-wins violated: %q", got.Description())
	}
	reg.Register(&fakeTool{Base: Base{ToolName: "hidden", Expose: Hidden}})
	for _, v := range reg.Visible() {
		if v.Name() == "hidden" {
			t.Fatal("hidden tool should not be visible")
		}
	}
}

// spyProbe spiller for spill test.
type fixedSpiller struct{ mu sync.Mutex }

func (s *fixedSpiller) Spill(id, full string) (string, error) {
	return fmt.Sprintf("[spilled %d bytes ref=%s]", len(full), id), nil
}

func TestDispatchSpillsLargeResult(t *testing.T) {
	reg := NewRegistry()
	big := make([]byte, 5000)
	for i := range big {
		big[i] = 'a'
	}
	reg.Register(newFake("dump", false, func(context.Context, map[string]any, ExecContext) (Result, error) {
		return Result{Content: string(big)}, nil
	}))
	ec := ExecContext{Spiller: &fixedSpiller{}, MaxResultBytes: 1000}
	res := Dispatch(context.Background(), []agent.ToolCall{{ID: "d", Name: "dump"}}, reg, ec, 4)
	if len(res[0].Content) >= 5000 {
		t.Fatalf("expected spilled preview, got %d bytes", len(res[0].Content))
	}
}

func TestBashViaLocalExecutor(t *testing.T) {
	reg := NewRegistry()
	reg.Register(NewBash())
	ec := ExecContext{Executor: bay.NewLocalExecutor()}
	res := Dispatch(context.Background(), []agent.ToolCall{
		{ID: "1", Name: "bash", Input: map[string]any{"command": "echo carrier"}},
	}, reg, ec, 4)
	if res[0].IsError || res[0].Content == "" {
		t.Fatalf("bash result = %+v", res[0])
	}
}

// TestBashInjectsExecContextEnv verifies per-session env/secrets in
// ExecContext.Env are visible to the command (and layered on the host env).
func TestBashInjectsExecContextEnv(t *testing.T) {
	reg := NewRegistry()
	reg.Register(NewBash())
	ec := ExecContext{
		Executor: bay.NewLocalExecutor(),
		Env:      []string{"CARRIER_TEST_SECRET=s3cr3t"},
	}
	res := Dispatch(context.Background(), []agent.ToolCall{
		{ID: "1", Name: "bash", Input: map[string]any{"command": "printf %s \"$CARRIER_TEST_SECRET\""}},
	}, reg, ec, 4)
	if res[0].IsError {
		t.Fatalf("bash error: %+v", res[0])
	}
	if got := res[0].Content; got != "s3cr3t" {
		t.Fatalf("env not injected: command saw %q, want %q", got, "s3cr3t")
	}
}
