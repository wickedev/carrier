package flight

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/bay"
	"github.com/wickedev/carrier/internal/plugin"
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

// TestFlightPerTurnOverride verifies that an input's optional Model/Effort/
// PlanMode overrides take effect for that turn and that a later input without
// overrides reverts to the session defaults.
func TestFlightPerTurnOverride(t *testing.T) {
	type capture struct {
		model, effort string
		tools         int
	}
	caps := make(chan capture, 4)
	step := func(in agent.StepInput) (agent.StepResult, error) {
		caps <- capture{in.Model, in.Effort, len(in.Tools)}
		return agent.StepResult{Done: true}, nil
	}
	eng := &fakeEngine{name: "fake", steps: []func(agent.StepInput) (agent.StepResult, error){step, step, step}}

	reg := tool.NewRegistry()
	reg.Register(echoTool{tool.Base{ToolName: "echo"}}) // mutating (ReadOnly=false), Direct exposure

	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	f := New(Config{
		ID: "test", System: "sys", Engine: eng, Store: st, Tools: reg,
		Exec:   tool.ExecContext{Executor: bay.NewLocalExecutor()},
		Model:  "sess-model",
		Effort: "sess-effort",
		// PlanMode default false → the mutating tool is visible by default.
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	recv := func() capture {
		t.Helper()
		select {
		case c := <-caps:
			return c
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for a turn")
			return capture{}
		}
	}

	// Turn 1: full overrides, including planMode=true (hides the mutating tool).
	planOn := true
	effMax := "max"
	if err := f.Queues().Submit(ctx, sq.Input{
		Msg: agent.Message{Role: agent.RoleUser, Text: "a"}, Delivery: sq.Queue,
		Model: "turbo", Effort: &effMax, PlanMode: &planOn,
	}); err != nil {
		t.Fatalf("submit 1: %v", err)
	}
	c1 := recv()
	if c1.model != "turbo" || c1.effort != "max" {
		t.Fatalf("turn1 model/effort = %q/%q, want turbo/max", c1.model, c1.effort)
	}
	if c1.tools != 0 {
		t.Fatalf("turn1 planMode override should hide the mutating tool, got %d visible", c1.tools)
	}

	// Turn 2: no overrides → revert to the session defaults (tool visible again).
	if err := f.Queues().Submit(ctx, sq.Input{
		Msg: agent.Message{Role: agent.RoleUser, Text: "b"}, Delivery: sq.Queue,
	}); err != nil {
		t.Fatalf("submit 2: %v", err)
	}
	c2 := recv()
	if c2.model != "sess-model" || c2.effort != "sess-effort" {
		t.Fatalf("turn2 model/effort = %q/%q, want sess-model/sess-effort", c2.model, c2.effort)
	}
	if c2.tools != 1 {
		t.Fatalf("turn2 should show the mutating tool (planMode reverted), got %d visible", c2.tools)
	}

	// Turn 3: an EXPLICIT empty-string effort ("auto") must override the non-empty
	// session default — a nil Effort would instead keep the default. This is the
	// case a plain string field could not express.
	effAuto := ""
	if err := f.Queues().Submit(ctx, sq.Input{
		Msg: agent.Message{Role: agent.RoleUser, Text: "c"}, Delivery: sq.Queue,
		Effort: &effAuto,
	}); err != nil {
		t.Fatalf("submit 3: %v", err)
	}
	c3 := recv()
	if c3.effort != "" {
		t.Fatalf("turn3 effort = %q, want \"\" (explicit auto override of sess-effort)", c3.effort)
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

// gateSeam is a test Seam that denies a named tool and overrides results.
type gateSeam struct {
	plugin.Base
	denyTool string
	override string
}

func (g *gateSeam) Supports(k plugin.SeamKind) bool {
	return k == plugin.SeamToolBefore || k == plugin.SeamToolAfter
}
func (g *gateSeam) ToolBefore(_ context.Context, in plugin.ToolBeforeInput) (plugin.ToolBeforeDecision, error) {
	if in.Tool == g.denyTool {
		return plugin.ToolBeforeDecision{Decision: plugin.DecisionDeny, Reason: "blocked by plugin"}, nil
	}
	return plugin.ToolBeforeDecision{Decision: plugin.DecisionAllow}, nil
}
func (g *gateSeam) ToolAfter(_ context.Context, _ plugin.ToolAfterInput) (plugin.ToolAfterPatch, error) {
	if g.override == "" {
		return plugin.ToolAfterPatch{}, nil
	}
	o := g.override
	return plugin.ToolAfterPatch{ResultOverride: &o}, nil
}

func TestFlightPluginDeniesTool(t *testing.T) {
	reg := tool.NewRegistry()
	reg.Register(tool.NewBash())
	eng := &fakeEngine{name: "fake", steps: []func(agent.StepInput) (agent.StepResult, error){
		func(in agent.StepInput) (agent.StepResult, error) {
			tc := agent.ToolCall{ID: "1", Name: "bash", Input: map[string]any{"command": "echo hi"}}
			in.OnEvent(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &tc})
			return agent.StepResult{ToolCalls: []agent.ToolCall{tc}, Done: false}, nil
		},
		func(in agent.StepInput) (agent.StepResult, error) {
			return agent.StepResult{Text: "done", Done: true}, nil
		},
	}}
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	f := New(Config{
		ID: "test", System: "sys", Engine: eng, Store: st, Tools: reg,
		Exec:    tool.ExecContext{Executor: bay.NewLocalExecutor()},
		Plugins: plugin.NewChain(plugin.Entry{Seam: &gateSeam{denyTool: "bash"}}),
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	submit(t, f, "run echo")
	events := collect(f.Queues().Events(), 500*time.Millisecond)
	cancel()

	if !hasToolResultContaining(events, "blocked by plugin") {
		t.Fatalf("plugin deny not applied: %v", kinds(events))
	}
	if hasToolResultContaining(events, "hi") {
		t.Fatal("denied tool should not have executed")
	}
}

func TestFlightPluginOverridesResult(t *testing.T) {
	reg := tool.NewRegistry()
	reg.Register(tool.NewBash())
	eng := &fakeEngine{name: "fake", steps: []func(agent.StepInput) (agent.StepResult, error){
		func(in agent.StepInput) (agent.StepResult, error) {
			tc := agent.ToolCall{ID: "1", Name: "bash", Input: map[string]any{"command": "echo hi"}}
			in.OnEvent(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &tc})
			return agent.StepResult{ToolCalls: []agent.ToolCall{tc}, Done: false}, nil
		},
		func(in agent.StepInput) (agent.StepResult, error) {
			return agent.StepResult{Text: "done", Done: true}, nil
		},
	}}
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	f := New(Config{
		ID: "test", System: "sys", Engine: eng, Store: st, Tools: reg,
		Exec:    tool.ExecContext{Executor: bay.NewLocalExecutor()},
		Plugins: plugin.NewChain(plugin.Entry{Seam: &gateSeam{override: "REDACTED"}}),
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	submit(t, f, "run echo")
	events := collect(f.Queues().Events(), 500*time.Millisecond)
	cancel()

	if !hasToolResultContaining(events, "REDACTED") {
		t.Fatalf("plugin result override not applied: %v", kinds(events))
	}
}

type fakeTitler struct {
	title string
	calls int32
}

func (t *fakeTitler) Title(_ context.Context, firstUser, _ string) (string, error) {
	atomic.AddInt32(&t.calls, 1)
	if firstUser == "" {
		return "", nil
	}
	return t.title, nil
}

func TestFlightAutoTitle(t *testing.T) {
	eng := &fakeEngine{name: "fake", steps: []func(agent.StepInput) (agent.StepResult, error){
		func(in agent.StepInput) (agent.StepResult, error) {
			in.OnEvent(agent.StreamEvent{Kind: agent.EvText, Text: "working"})
			return agent.StepResult{Text: "working", Done: true}, nil
		},
		func(in agent.StepInput) (agent.StepResult, error) {
			return agent.StepResult{Text: "more", Done: true}, nil
		},
	}}
	titler := &fakeTitler{title: "Fix The Login Bug"}
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	f := New(Config{
		ID: "test", System: "sys", Engine: eng, Store: st,
		Exec:   tool.ExecContext{Executor: bay.NewLocalExecutor()},
		Titler: titler,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = f.Run(ctx) }()

	submit(t, f, "the login button does nothing")
	events := collect(f.Queues().Events(), 400*time.Millisecond)

	var titles []string
	for _, e := range events {
		if e.Kind == agent.EvTitleSuggested {
			titles = append(titles, e.Title)
		}
	}
	if len(titles) != 1 || titles[0] != "Fix The Login Bug" {
		t.Fatalf("expected one title 'Fix The Login Bug', got %v", titles)
	}

	// A second input must NOT re-title.
	submit(t, f, "another request")
	more := collect(f.Queues().Events(), 400*time.Millisecond)
	cancel()
	for _, e := range more {
		if e.Kind == agent.EvTitleSuggested {
			t.Fatal("title should be suggested only once")
		}
	}
	if got := atomic.LoadInt32(&titler.calls); got != 1 {
		t.Fatalf("titler called %d times, want 1", got)
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
