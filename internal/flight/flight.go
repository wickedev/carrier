// Package flight is one agent session: a single conversation driven to
// completion by an Engine, with tool calls executed (via tool.Dispatch) in a
// confined Executor, history persisted to a Store, and input/output carried over
// per-session SQ/EQ queues. One Flight is one goroutine.
package flight

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/engine"
	"github.com/wickedev/carrier/internal/perm"
	"github.com/wickedev/carrier/internal/plugin"
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

// Titler proposes a short session title from the first exchange. A new session
// starts "Untitled"; after the first turn the Flight emits an EvTitleSuggested
// event so the surface can rename it. A real implementation calls a cheap model.
type Titler interface {
	Title(ctx context.Context, firstUser, firstAssistant string) (string, error)
}

// Config constructs a Flight.
type Config struct {
	ID     string
	System string
	// Memory is durable instruction/context (e.g. AGENTS.md) injected ahead of
	// the conversation but outside the mutable history, so it is never
	// compacted. See internal/memory.
	Memory string
	// Model, when set, overrides the Engine's default model for this session.
	// Effort selects the reasoning-effort level where the provider supports it.
	Model  string
	Effort string
	// Plugins is the per-session seam chain (nil → no plugins). Its seams
	// transform the request, gate/rewrite tool calls, and weigh in on permission.
	Plugins     *plugin.Chain
	Engine      engine.Engine
	Store       store.Store
	Tools       *tool.Registry
	Policy      perm.Policy // nil → permissive (allow all); a server sets this
	Exec        tool.ExecContext
	Approver    Approver
	Classifier  perm.Classifier // nil → Ask falls straight to the Approver
	Summarizer  Summarizer      // nil → placeholder compaction summary
	Titler      Titler          // nil → no auto title
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
	model       string
	effort      string
	plugins     *plugin.Chain
	engine      engine.Engine
	store       store.Store
	tools       *tool.Registry
	policy      perm.Policy
	exec        tool.ExecContext
	approver    Approver
	classifier  perm.Classifier
	denials     *perm.DenialTracker
	summarizer  Summarizer
	titler      Titler
	titled      bool // whether an auto title has been suggested yet
	maxSteps    int
	idleTimeout time.Duration
	maxParallel int
	budget      int
	planMode    bool

	// curModel/curEffort/curPlanMode are the EFFECTIVE model params for the turn
	// sequence currently being processed. They default to the session values
	// (model/effort/planMode) and are recomputed from each folded input's
	// optional per-turn overrides in foldPending. runTurn, decide, and
	// visibleTools read these so a single message can run on a different model,
	// effort, or plan mode without disturbing the session defaults.
	curModel    string
	curEffort   string
	curPlanMode bool

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
		model:       cfg.Model,
		effort:      cfg.Effort,
		plugins:     orChain(cfg.Plugins),
		engine:      cfg.Engine,
		store:       cfg.Store,
		tools:       cfg.Tools,
		policy:      cfg.Policy,
		exec:        cfg.Exec,
		approver:    cfg.Approver,
		classifier:  cfg.Classifier,
		denials:     perm.NewDenialTracker(5),
		summarizer:  cfg.Summarizer,
		titler:      cfg.Titler,
		maxSteps:    orDefault(cfg.MaxSteps, defaultMaxSteps),
		idleTimeout: orDefaultDur(cfg.IdleTimeout, defaultIdleTimeout),
		maxParallel: orDefault(cfg.MaxParallel, defaultMaxParallel),
		budget:      cfg.ContextBudget,
		planMode:    cfg.PlanMode,
		curModel:    cfg.Model,
		curEffort:   cfg.Effort,
		curPlanMode: cfg.PlanMode,
	}
	f.queues = sq.New(orDefault(cfg.SQCap, defaultSQCap), orDefault(cfg.EQCap, defaultEQCap), sq.Shed)
	return f
}

// ID returns the session ID.
func (f *Flight) ID() string { return f.id }

// Queues exposes the SQ/EQ queues so callers can Submit input and read Events.
func (f *Flight) Queues() *sq.Queues { return f.queues }

// SetApprover installs (or replaces) the human-in-the-loop Approver. Call it
// before Run starts (no active turn) — e.g. the server wires a hitl.ChannelApprover
// right after constructing the Flight so Ask-effect tools surface for approval.
func (f *Flight) SetApprover(a Approver) { f.approver = a }

func (f *Flight) sid() store.SessionID { return store.SessionID(f.id) }

// Run drives the session until ctx is cancelled. It blocks for input, runs
// turns until the model is idle, and repeats. Each Flight is one goroutine.
func (f *Flight) Run(ctx context.Context) error {
	defer f.queues.Close()
	// session_start plugin seams may inject durable context for the whole session.
	if extra := f.plugins.SessionStart(ctx, plugin.LifecycleInput{SessionID: string(f.sid())}); extra != "" {
		if f.memory != "" {
			f.memory += "\n\n"
		}
		f.memory += extra
	}
	// session_end runs even on cancellation (cleanup/side-effects in the seam).
	defer f.plugins.SessionEnd(context.WithoutCancel(ctx), plugin.LifecycleInput{SessionID: string(f.sid())})
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
		// Resolve the effective model params for the upcoming turns from this
		// input's optional overrides, falling back to the session defaults. When
		// several inputs are folded together (queued/steered mid-turn), the most
		// recent one wins — each starts from the defaults so an unset field never
		// inherits a prior message's override.
		f.curModel = f.model
		if in.Model != "" {
			f.curModel = in.Model
		}
		f.curEffort = f.effort
		if in.Effort != "" {
			f.curEffort = in.Effort
		}
		f.curPlanMode = f.planMode
		if in.PlanMode != nil {
			f.curPlanMode = *in.PlanMode
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

		// Auto-title: once, after the first turn, derive a short title from the
		// opening exchange and emit it so the surface can rename the session.
		f.maybeSuggestTitle(ctx, msgs, res.Text)

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
		Model:    f.curModel,
		Effort:   f.curEffort,
		OnEvent: func(ev agent.StreamEvent) {
			select {
			case activity <- struct{}{}:
			default:
			}
			f.emit(turnCtx, ev)
		},
	}
	// before_step plugin seams may append to the system prompt, override
	// model/effort (clamped downstream by the engine), or filter the tool set.
	f.plugins.BeforeStep(turnCtx, f.id, &in)

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
	gated := make([]agent.ToolCall, len(calls)) // calls with plugin-rewritten input
	var allowed []agent.ToolCall
	for i, c := range calls {
		pos[c.ID] = i
		gated[i] = c
		// tool_before plugin seams: may deny, ask, rewrite input, or add context.
		gate := f.plugins.ToolBefore(ctx, f.id, c)
		c.Input = gate.Input
		gated[i] = c
		if gate.Effect == plugin.DecisionDeny {
			results[i] = deniedResult(c.ID, gate.Reason)
			continue
		}
		if f.decide(ctx, c, gate.Effect == plugin.DecisionAsk) == perm.Allow {
			allowed = append(allowed, c)
		} else {
			results[i] = deniedResult(c.ID, gate.Reason)
		}
	}
	for _, r := range tool.Dispatch(ctx, allowed, f.tools, f.exec, f.maxParallel) {
		i := pos[r.ToolCallID]
		// tool_after plugin seams: may override the result or append context.
		f.plugins.ToolAfter(ctx, f.id, gated[i], &r)
		results[i] = r
	}
	return results
}

func deniedResult(id, reason string) agent.ToolResult {
	msg := "error: permission denied"
	if reason != "" {
		msg += ": " + reason
	}
	return agent.ToolResult{ToolCallID: id, Content: msg, IsError: true}
}

// decide resolves the permission effect for a tool call, consulting plan mode,
// the policy, the permission_ask plugin seams, and (for Ask) the Approver.
// forceAsk reflects a tool_before plugin decision of "ask", which raises an
// otherwise-Allow effect to Ask.
func (f *Flight) decide(ctx context.Context, c agent.ToolCall, forceAsk bool) perm.Effect {
	if f.curPlanMode && !f.toolReadOnly(c) {
		return perm.Deny // plan mode forbids mutating actions
	}
	eff := perm.Allow // permissive default; a server installs a policy
	if f.policy != nil {
		eff = f.policy.Evaluate(c.Name, resourceFor(c)).Effect
	}
	// permission_ask plugin seams. Most-restrictive wins: a plugin deny is
	// terminal; a plugin allow (opted-in) only relaxes an Ask, never a Deny
	// (layer-aware trust — a plugin can never escalate over a policy denial);
	// a plugin ask raises an Allow to Ask.
	if pd, _, had := f.plugins.PermissionAsk(ctx, plugin.PermissionInput{
		SessionID: f.id, Action: c.Name, Resource: resourceFor(c),
	}); had {
		switch pd {
		case plugin.DecisionDeny:
			return perm.Deny
		case plugin.DecisionAllow:
			if eff == perm.Ask {
				eff = perm.Allow
			}
		case plugin.DecisionAsk:
			if eff == perm.Allow {
				eff = perm.Ask
			}
		}
	}
	if forceAsk && eff == perm.Allow {
		eff = perm.Ask
	}
	if eff != perm.Ask {
		return eff
	}
	// Ask: consult the off-loop classifier first on a sanitized projection
	// (action + resource only), tracking consecutive denials so a noisy
	// classifier falls back to human approval instead of silently blocking.
	if f.classifier != nil {
		if eff, err := f.classifier.Classify(ctx, c.Name, resourceFor(c)); err == nil && eff != perm.Ask {
			if !f.denials.Record(eff == perm.Deny) {
				return eff
			}
		}
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
		if f.curPlanMode && !t.IsReadOnly(nil) {
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

// maybeSuggestTitle generates and emits a session title exactly once, from the
// first user message (and the first assistant reply). It is best-effort: a nil
// Titler or any failure leaves the session "Untitled". The titled flag is set
// up-front so a failed attempt is not retried.
func (f *Flight) maybeSuggestTitle(ctx context.Context, history []agent.Message, assistant string) {
	if f.titled || f.titler == nil {
		return
	}
	f.titled = true
	first := firstUserText(history)
	if first == "" {
		return
	}
	title, err := f.titler.Title(ctx, first, assistant)
	if err != nil || title == "" {
		return
	}
	f.emit(ctx, agent.StreamEvent{Kind: agent.EvTitleSuggested, Title: title})
}

func firstUserText(history []agent.Message) string {
	for _, m := range history {
		if m.Role == agent.RoleUser && m.Text != "" {
			return m.Text
		}
	}
	return ""
}

// EngineTitler proposes a short session title via one cheap Engine call.
type EngineTitler struct {
	Engine engine.Engine
	System string // optional override
}

func (t EngineTitler) Title(ctx context.Context, firstUser, firstAssistant string) (string, error) {
	sys := t.System
	if sys == "" {
		sys = "Write a concise session title (3-6 words, Title Case, no quotes or trailing punctuation) summarizing the user's task. Output only the title."
	}
	prompt := "User request:\n" + firstUser
	if firstAssistant != "" {
		prompt += "\n\nAssistant reply:\n" + firstAssistant
	}
	res, err := t.Engine.RunStep(ctx, agent.StepInput{
		System:   sys,
		Messages: []agent.Message{{Role: agent.RoleUser, Text: prompt}},
	})
	if err != nil {
		return "", err
	}
	return cleanTitle(res.Text), nil
}

// cleanTitle trims whitespace/quotes and caps the title length.
func cleanTitle(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "\"'`")
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	if len(s) > 80 {
		s = strings.TrimSpace(s[:80])
	}
	return s
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

// orChain returns c, or an empty (no-op) Chain when c is nil, so the Flight can
// call plugin seams unconditionally.
func orChain(c *plugin.Chain) *plugin.Chain {
	if c == nil {
		return plugin.NewChain()
	}
	return c
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
