package flight

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/bay"
	"github.com/wickedev/carrier/internal/sq"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tool"
)

// fakeEngine plays a scripted sequence of turns. Each step may emit events via
// in.OnEvent (mirroring a real streaming engine) and returns a StepResult.
type fakeEngine struct {
	name  string
	steps []func(in agent.StepInput) (agent.StepResult, error)
	calls int32
}

func (e *fakeEngine) Name() string { return e.name }

func (e *fakeEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	n := int(atomic.AddInt32(&e.calls, 1)) - 1
	if n >= len(e.steps) {
		// Default: finish with no output (keeps the loop from spinning).
		return agent.StepResult{Done: true}, nil
	}
	return e.steps[n](in)
}

type echoTool struct{ tool.Base }

func (echoTool) Exec(context.Context, map[string]any, tool.ExecContext) (tool.Result, error) {
	return tool.Result{Content: "ok"}, nil
}

func newFlight(t *testing.T, eng *fakeEngine, reg *tool.Registry, maxSteps int) *Flight {
	t.Helper()
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if reg == nil {
		reg = tool.NewRegistry()
	}
	return New(Config{
		ID:       "test",
		System:   "sys",
		Engine:   eng,
		Store:    st,
		Tools:    reg,
		Exec:     tool.ExecContext{Executor: bay.NewLocalExecutor()},
		MaxSteps: maxSteps,
	})
}

// collect drains events until the channel is quiet for `quiet` or closes.
func collect(events <-chan agent.StreamEvent, quiet time.Duration) []agent.StreamEvent {
	var out []agent.StreamEvent
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return out
			}
			out = append(out, ev)
		case <-time.After(quiet):
			return out
		}
	}
}

func submit(t *testing.T, f *Flight, text string) {
	t.Helper()
	if err := f.Queues().Submit(context.Background(), sq.Input{
		Msg: agent.Message{Role: agent.RoleUser, Text: text}, Delivery: sq.Queue,
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
}

func TestFlightSimpleTurn(t *testing.T) {
	eng := &fakeEngine{name: "fake", steps: []func(agent.StepInput) (agent.StepResult, error){
		func(in agent.StepInput) (agent.StepResult, error) {
			in.OnEvent(agent.StreamEvent{Kind: agent.EvText, Text: "hi"})
			return agent.StepResult{Text: "hi", Done: true}, nil
		},
	}}
	f := newFlight(t, eng, nil, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	submit(t, f, "hello")
	events := collect(f.Queues().Events(), 300*time.Millisecond)
	cancel()

	if !hasText(events, "hi") {
		t.Fatalf("expected EvText 'hi', got %v", kinds(events))
	}
}

func TestFlightToolLoop(t *testing.T) {
	reg := tool.NewRegistry()
	reg.Register(tool.NewBash())
	eng := &fakeEngine{name: "fake", steps: []func(agent.StepInput) (agent.StepResult, error){
		func(in agent.StepInput) (agent.StepResult, error) {
			tc := agent.ToolCall{ID: "1", Name: "bash", Input: map[string]any{"command": "echo hi"}}
			in.OnEvent(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &tc})
			return agent.StepResult{ToolCalls: []agent.ToolCall{tc}, Done: false}, nil
		},
		func(in agent.StepInput) (agent.StepResult, error) {
			in.OnEvent(agent.StreamEvent{Kind: agent.EvText, Text: "done"})
			return agent.StepResult{Text: "done", Done: true}, nil
		},
	}}
	f := newFlight(t, eng, reg, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	submit(t, f, "run echo")
	events := collect(f.Queues().Events(), 500*time.Millisecond)
	cancel()

	if !hasKind(events, agent.EvToolCall) {
		t.Fatalf("missing EvToolCall: %v", kinds(events))
	}
	if !hasToolResultContaining(events, "hi") {
		t.Fatalf("missing tool result 'hi': %v", kinds(events))
	}
	if !hasText(events, "done") {
		t.Fatalf("missing final text 'done': %v", kinds(events))
	}
}

func TestFlightToolErrorFeedback(t *testing.T) {
	eng := &fakeEngine{name: "fake", steps: []func(agent.StepInput) (agent.StepResult, error){
		func(in agent.StepInput) (agent.StepResult, error) {
			tc := agent.ToolCall{ID: "1", Name: "does-not-exist"}
			in.OnEvent(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &tc})
			return agent.StepResult{ToolCalls: []agent.ToolCall{tc}}, nil
		},
		func(agent.StepInput) (agent.StepResult, error) {
			return agent.StepResult{Text: "ok", Done: true}, nil
		},
	}}
	f := newFlight(t, eng, nil, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	submit(t, f, "go")
	events := collect(f.Queues().Events(), 400*time.Millisecond)
	cancel()

	found := false
	for _, ev := range events {
		if ev.Kind == agent.EvToolResult && ev.Result != nil && ev.Result.IsError {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected an error tool result, got %v", kinds(events))
	}
}

func TestFlightStepBudget(t *testing.T) {
	reg := tool.NewRegistry()
	reg.Register(&echoTool{Base: tool.Base{ToolName: "noop"}})
	// Engine never finishes — always asks for a tool.
	loop := func(in agent.StepInput) (agent.StepResult, error) {
		tc := agent.ToolCall{ID: "x", Name: "noop"}
		return agent.StepResult{ToolCalls: []agent.ToolCall{tc}}, nil
	}
	steps := make([]func(agent.StepInput) (agent.StepResult, error), 100)
	for i := range steps {
		steps[i] = loop
	}
	eng := &fakeEngine{name: "fake", steps: steps}
	f := newFlight(t, eng, reg, 3) // budget of 3 turns
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	submit(t, f, "go")
	collect(f.Queues().Events(), 400*time.Millisecond)
	cancel()

	if got := atomic.LoadInt32(&eng.calls); got != 3 {
		t.Fatalf("engine called %d times, want exactly MaxSteps=3", got)
	}
}

// helpers

func hasText(evs []agent.StreamEvent, s string) bool {
	for _, e := range evs {
		if e.Kind == agent.EvText && e.Text == s {
			return true
		}
	}
	return false
}

func hasKind(evs []agent.StreamEvent, k agent.EventKind) bool {
	for _, e := range evs {
		if e.Kind == k {
			return true
		}
	}
	return false
}

func hasToolResultContaining(evs []agent.StreamEvent, sub string) bool {
	for _, e := range evs {
		if e.Kind == agent.EvToolResult && e.Result != nil &&
			len(e.Result.Content) > 0 && contains(e.Result.Content, sub) {
			return true
		}
	}
	return false
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func kinds(evs []agent.StreamEvent) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.Kind.String()
	}
	return out
}
