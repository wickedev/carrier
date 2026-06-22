// Package flight is one agent session: a single conversation driven to
// completion by an Engine, with tool calls executed (via tool.Dispatch) in a
// confined Executor, history persisted to a Store, and input/output carried over
// per-session SQ/EQ queues. One Flight is one goroutine.
package flight

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/engine"
	"github.com/wickedev/carrier/internal/perm"
	"github.com/wickedev/carrier/internal/sq"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tool"
)

const (
	defaultMaxSteps    = 50
	defaultIdleTimeout = 2 * time.Minute
	defaultSQCap       = 16
	defaultEQCap       = 256
	defaultMaxParallel = tool.DefaultMaxParallel
)

// errSteered signals that a turn was interrupted by a steer input.
var errSteered = errors.New("flight: turn steered")

// errIdleTimeout signals that a streaming turn stalled past the idle timeout.
var errIdleTimeout = errors.New("flight: idle timeout")

// Approver decides Ask-effect permission requests. A server wires this to a
// human round-trip; if nil, Ask is treated as Deny.
type Approver interface {
	Approve(ctx context.Context, req ApprovalRequest) (bool, error)
}

// ApprovalRequest describes a tool action awaiting approval.
type ApprovalRequest struct {
	Tool     string
	Resource string
	Reason   string
}

// Summarizer condenses conversation history into a single carry-forward note,
// used by compaction. A real implementation calls a (cheap) model.
type Summarizer interface {
	Summarize(ctx context.Context, history []agent.Message) (string, error)
}

// Config constructs a Flight.
type Config struct {
	ID     string
	System string
	// Memory is durable instruction/context (e.g. AGENTS.md) injected ahead of
	// the conversation but outside the mutable history, so it is never
	// compacted. See internal/memory.
	Memory      string
	Engine      engine.Engine
	Store       store.Store
	Tools       *tool.Registry
	Policy      perm.Policy // nil → permissive (allow all); a server sets this
	Exec        tool.ExecContext
	Approver    Approver
	Summarizer  Summarizer // nil → placeholder compaction summary
	MaxSteps    int
	IdleTimeout time.Duration
	MaxParallel int
	// ContextBudget triggers proactive compaction once a turn's input tokens
	// reach this threshold (0 → disabled).
	ContextBudget int
	// PlanMode restricts the Flight to read-only tools (no mutating actions).
	PlanMode bool
	SQCap    int
	EQCap    int
}

// Flight holds everything one session needs to run.
type Flight struct {
	id          string
	system      string
	memory      string
	engine      engine.Engine
	store       store.Store
	tools       *tool.Registry
	policy      perm.Policy
	exec        tool.ExecContext
	approver    Approver
	summarizer  Summarizer
	maxSteps    int
	idleTimeout time.Duration
	maxParallel int
	budget      int
	planMode    bool

	queues *sq.Queues

	// pending holds inputs consumed mid-turn (during the steer/idle watchdog)
	// that must be folded into history before the next turn. Owned by the Run
	// goroutine; no synchronization needed.
	pending []sq.Input
}

// New builds a Flight ready to run.
func New(cfg Config) *Flight {
	f := &Flight{
		id:          cfg.ID,
		system:      cfg.System,
		memory:      cfg.Memory,
		engine:      cfg.Engine,
		store:       cfg.Store,
		tools:       cfg.Tools,
		policy:      cfg.Policy,
		exec:        cfg.Exec,
		approver:    cfg.Approver,
		summarizer:  cfg.Summarizer,
		maxSteps:    orDefault(cfg.MaxSteps, defaultMaxSteps),
		idleTimeout: orDefaultDur(cfg.IdleTimeout, defaultIdleTimeout),
		maxParallel: orDefault(cfg.MaxParallel, defaultMaxParallel),
		budget:      cfg.ContextBudget,
		planMode:    cfg.PlanMode,
	}
	f.queues = sq.New(orDefault(cfg.SQCap, defaultSQCap), orDefault(cfg.EQCap, defaultEQCap), sq.Shed)
	return f
}

// ID returns the session ID.
func (f *Flight) ID() string { return f.id }

// Queues exposes the SQ/EQ queues so callers can Submit input and read Events.
func (f *Flight) Queues() *sq.Queues { return f.queues }

func (f *Flight) sid() store.SessionID { return store.SessionID(f.id) }

// Run drives the session until ctx is cancelled. It blocks for input, runs
// turns until the model is idle, and repeats. Each Flight is one goroutine.
func (f *Flight) Run(ctx context.Context) error {
	defer f.queues.Close()
	for {
		// Block for input unless inputs were already buffered mid-turn.
		if len(f.pending) == 0 {
			in, ok := f.queues.Next(ctx)
			if !ok {
				return ctx.Err()
			}
			f.pending = append(f.pending, in)
		}
		if err := f.foldPending(ctx); err != nil {
			return err
		}
		if err := f.runUntilIdle(ctx); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			// Non-fatal turn errors (idle timeout, steer) loop back to fold any
			// pending input and continue; a fatal engine error returns.
			var ee *agent.EngineError
			if errors.As(err, &ee) && ee.Class == agent.ErrFatal {
				f.emit(ctx, agent.StreamEvent{Kind: agent.EvError, Err: ee})
				return err
			}
		}
	}
}

// foldPending appends buffered inputs to history (as user turns) and clears the
// buffer.
func (f *Flight) foldPending(ctx context.Context) error {
	for _, in := range f.pending {
		rec := store.Record{Kind: store.KindTurn, Role: agent.RoleUser, Text: in.Msg.Text}
		if err := f.store.Append(ctx, f.sid(), rec); err != nil {
			return err
		}
	}
	f.pending = f.pending[:0]
	return nil
}

// runUntilIdle runs turns until the model finishes with no pending input, the
// step budget is exhausted, or a recoverable interruption occurs.
func (f *Flight) runUntilIdle(ctx context.Context) error {
	var lastInputTokens int
	for step := 0; step < f.maxSteps; step++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Proactive compaction: condense history before the provider forces it.
		if f.budget > 0 && lastInputTokens >= f.budget {
			if err := f.compact(ctx); err != nil {
				return err
			}
			lastInputTokens = 0
		}
		msgs, err := f.store.Messages(ctx, f.sid())
		if err != nil {
			return err
		}

		res, terr := f.runTurn(ctx, msgs)
		switch {
		case errors.Is(terr, errSteered):
			return errSteered // outer loop folds the steer input and resumes
		case errors.Is(terr, errIdleTimeout):
			f.emit(ctx, agent.StreamEvent{Kind: agent.EvError, Err: &agent.EngineError{
				Class: agent.ErrRetryable, Provider: f.engine.Name(), Message: "idle timeout",
			}})
			return errIdleTimeout
		case terr != nil:
			var ee *agent.EngineError
			if errors.As(terr, &ee) && ee.Class == agent.ErrContextOverflow {
				// Recovery transition: compact, then retry the same step.
				if cerr := f.compact(ctx); cerr != nil {
					return cerr
				}
				step--
				continue
			}
			return terr
		}

		lastInputTokens = res.Usage.InputTokens

		// Persist the assistant turn (text + any tool-call requests).
		arec := store.Record{Kind: store.KindTurn, Role: agent.RoleAssistant, Text: res.Text, ToolCalls: res.ToolCalls}
		if err := f.store.Append(ctx, f.sid(), arec); err != nil {
			return err
		}

		if res.Done {
			return nil // idle; outer loop blocks for the next input
		}

		// Dispatch tool calls through the permission gate, persist each result.
		results := f.gatedDispatch(ctx, res.ToolCalls)
		for _, r := range results {
			rr := r
			rrec := store.Record{Kind: store.KindTurn, Role: agent.RoleTool, ToolResult: &rr}
			if err := f.store.Append(ctx, f.sid(), rrec); err != nil {
				return err
			}
			f.emit(ctx, agent.StreamEvent{Kind: agent.EvToolResult, Result: &rr})
		}
	}
	return fmt.Errorf("flight %s: exceeded step budget (%d)", f.id, f.maxSteps)
}

// runTurn runs exactly one Engine turn, streaming events to the EQ, with a
// per-receive idle timeout and steer interruption. Inputs consumed by the
// watchdog are buffered into f.pending.
func (f *Flight) runTurn(ctx context.Context, msgs []agent.Message) (agent.StepResult, error) {
	turnCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	activity := make(chan struct{}, 64)
	in := agent.StepInput{
		System:   f.effectiveSystem(),
		Messages: msgs,
		Tools:    f.visibleTools(),
		OnEvent: func(ev agent.StreamEvent) {
			select {
			case activity <- struct{}{}:
			default:
			}
			f.emit(turnCtx, ev)
		},
	}

	type outcome struct {
		res agent.StepResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		r, e := f.engine.RunStep(turnCtx, in)
		done <- outcome{r, e}
	}()

	idle := time.NewTimer(f.idleTimeout)
	defer idle.Stop()

	for {
		select {
		case o := <-done:
			return o.res, o.err
		case <-activity:
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(f.idleTimeout)
		case <-f.queues.WakeCh():
			if f.drainInputs() { // a steer arrived
				cancel()
				<-done
				return agent.StepResult{}, errSteered
			}
		case <-idle.C:
			cancel()
			<-done
			return agent.StepResult{}, errIdleTimeout
		case <-ctx.Done():
			cancel()
			<-done
			return agent.StepResult{}, ctx.Err()
		}
	}
}

// drainInputs pulls all currently-available inputs into f.pending and reports
// whether any was a steer (which should interrupt the active turn).
func (f *Flight) drainInputs() (steered bool) {
	for {
		next, ok := f.queues.TryNext()
		if !ok {
			return steered
		}
		f.pending = append(f.pending, next)
		if next.Delivery == sq.Steer {
			steered = true
		}
	}
}

// gatedDispatch evaluates permission for each call, executes the allowed ones
// via tool.Dispatch, and synthesizes denied results for the rest — preserving
// order and IDs.
func (f *Flight) gatedDispatch(ctx context.Context, calls []agent.ToolCall) []agent.ToolResult {
	results := make([]agent.ToolResult, len(calls))
	pos := make(map[string]int, len(calls))
	var allowed []agent.ToolCall
	for i, c := range calls {
		pos[c.ID] = i
		switch f.decide(ctx, c) {
		case perm.Allow:
			allowed = append(allowed, c)
		default: // Deny (or Ask without approval)
			results[i] = agent.ToolResult{
				ToolCallID: c.ID,
				Content:    "error: permission denied",
				IsError:    true,
			}
		}
	}
	for _, r := range tool.Dispatch(ctx, allowed, f.tools, f.exec, f.maxParallel) {
		results[pos[r.ToolCallID]] = r
	}
	return results
}

// decide resolves the permission effect for a tool call, consulting plan mode,
// the policy, and (for Ask) the Approver.
func (f *Flight) decide(ctx context.Context, c agent.ToolCall) perm.Effect {
	if f.planMode && !f.toolReadOnly(c) {
		return perm.Deny // plan mode forbids mutating actions
	}
	if f.policy == nil {
		return perm.Allow // permissive default; a server installs a policy
	}
	d := f.policy.Evaluate(c.Name, resourceFor(c))
	if d.Effect != perm.Ask {
		return d.Effect
	}
	if f.approver == nil {
		return perm.Deny
	}
	ok, err := f.approver.Approve(ctx, ApprovalRequest{Tool: c.Name, Resource: resourceFor(c)})
	if err != nil || !ok {
		return perm.Deny
	}
	return perm.Allow
}

// compact writes a checkpoint record summarizing prior history, so subsequent
// history replay starts from the summary. With a Summarizer it produces a real
// model-written note; otherwise a placeholder marker.
func (f *Flight) compact(ctx context.Context) error {
	summary := "[context compacted]"
	if f.summarizer != nil {
		if msgs, err := f.store.Messages(ctx, f.sid()); err == nil {
			if s, serr := f.summarizer.Summarize(ctx, msgs); serr == nil && s != "" {
				summary = s
			}
		}
	}
	return f.store.Append(ctx, f.sid(), store.Record{
		Kind: store.KindCheckpoint,
		Role: agent.RoleAssistant,
		Text: summary,
	})
}

func (f *Flight) emit(ctx context.Context, ev agent.StreamEvent) {
	_ = f.queues.Emit(ctx, ev)
}

func resourceFor(c agent.ToolCall) string {
	for _, key := range []string{"command", "path", "file_path", "url"} {
		if v, ok := c.Input[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// effectiveSystem prepends durable memory (never compacted) to the system
// prompt.
func (f *Flight) effectiveSystem() string {
	switch {
	case f.memory == "":
		return f.system
	case f.system == "":
		return f.memory
	default:
		return f.memory + "\n\n" + f.system
	}
}

// visibleTools returns the model-visible tool definitions, filtered to
// read-only tools in plan mode.
func (f *Flight) visibleTools() []agent.Tool {
	if f.tools == nil {
		return nil
	}
	var defs []agent.Tool
	for _, t := range f.tools.Visible() {
		if f.planMode && !t.IsReadOnly(nil) {
			continue
		}
		defs = append(defs, agent.Tool{
			Name:        t.Name(),
			Description: t.Description(),
			Schema:      t.Schema(),
		})
	}
	return defs
}

func (f *Flight) toolReadOnly(c agent.ToolCall) bool {
	if f.tools == nil {
		return false
	}
	t, ok := f.tools.Get(c.Name)
	if !ok {
		return false
	}
	return t.IsReadOnly(c.Input)
}

// EngineSummarizer summarizes history by asking an Engine for a concise note.
// It is the default Summarizer for compaction.
type EngineSummarizer struct {
	Engine engine.Engine
	System string
}

// Summarize implements Summarizer.
func (s EngineSummarizer) Summarize(ctx context.Context, history []agent.Message) (string, error) {
	sys := s.System
	if sys == "" {
		sys = "Summarize the conversation so far into a concise note preserving key decisions, file paths, and open tasks. Output only the summary."
	}
	msgs := append(append([]agent.Message{}, history...),
		agent.Message{Role: agent.RoleUser, Text: "Produce the summary now."})
	res, err := s.Engine.RunStep(ctx, agent.StepInput{System: sys, Messages: msgs})
	if err != nil {
		return "", err
	}
	return res.Text, nil
}

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func orDefaultDur(v, def time.Duration) time.Duration {
	if v <= 0 {
		return def
	}
	return v
}
