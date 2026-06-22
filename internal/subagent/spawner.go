// Package subagent implements Carrier's multi-agent fan-out (Req 13): a parent
// Flight delegates work to child Flights ("sub-agents") that run the same loop
// on their own goroutines, under a derived permission ceiling, with bounded
// concurrency and bounded recursion depth. A child returns a summarized result
// (its final assistant text) to the parent rather than its full transcript.
package subagent

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/sync/semaphore"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/engine"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/perm"
	"github.com/wickedev/carrier/internal/sq"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tool"
)

const (
	// defaultChildMaxSteps caps a sub-agent's step budget. A sub-agent is meant
	// to be a small, focused unit of work, so it gets a tight budget by default.
	defaultChildMaxSteps = 12

	// drainIdle is how long Spawn waits with no further child text before it
	// decides the child has gone quiet and returns the accumulated summary.
	drainIdle = 750 * time.Millisecond
)

// SpawnerConfig configures a Spawner. The Engine/Store/Tools/Exec/Policy are
// shared with (typically inherited from) the parent runtime; MaxConcurrent and
// MaxDepth bound fan-out and recursion respectively.
type SpawnerConfig struct {
	Engine        engine.Engine
	Store         store.Store
	Tools         *tool.Registry
	Exec          tool.ExecContext
	Policy        perm.Policy
	MaxConcurrent int
	MaxDepth      int
}

// Spawner builds and runs child Flights on demand. It bounds concurrent
// children with a weighted semaphore (Req 13.3) and bounds recursion depth
// (Req 13.4). A single Spawner is safe for concurrent use.
type Spawner struct {
	engine   engine.Engine
	store    store.Store
	tools    *tool.Registry
	exec     tool.ExecContext
	policy   perm.Policy
	maxDepth int
	maxSteps int

	sem     *semaphore.Weighted
	counter atomic.Uint64
}

const (
	defaultMaxConcurrent = 4
	defaultMaxDepth      = 3
)

// New builds a Spawner from cfg, applying defaults for unset bounds.
func New(cfg SpawnerConfig) *Spawner {
	maxConc := cfg.MaxConcurrent
	if maxConc < 1 {
		maxConc = defaultMaxConcurrent
	}
	maxDepth := cfg.MaxDepth
	if maxDepth < 1 {
		maxDepth = defaultMaxDepth
	}
	return &Spawner{
		engine:   cfg.Engine,
		store:    cfg.Store,
		tools:    cfg.Tools,
		exec:     cfg.Exec,
		policy:   DeriveCeiling(cfg.Policy),
		maxDepth: maxDepth,
		maxSteps: defaultChildMaxSteps,
		sem:      semaphore.NewWeighted(int64(maxConc)),
	}
}

// MaxDepth reports the configured recursion bound.
func (s *Spawner) MaxDepth() int { return s.maxDepth }

// Spawn runs a child Flight for prompt and returns its summarized result (the
// child's final assistant text). depth is the caller's depth in the session
// tree; the child runs at depth+1.
//
// It enforces the recursion bound (Req 13.4), acquires the concurrency
// semaphore (Req 13.3), runs the child on its own goroutine, submits prompt as
// a user input, drains the child's event stream collecting assistant text until
// the stream goes quiet, then cancels the child and returns the accumulated
// text (Req 13.5).
func (s *Spawner) Spawn(ctx context.Context, parentID, prompt string, depth int) (summary string, err error) {
	if depth >= s.maxDepth {
		return "", fmt.Errorf("subagent: recursion depth %d exceeds max %d", depth, s.maxDepth)
	}

	// Bounded fan-out: block until a concurrency slot is free (Req 13.3).
	if err := s.sem.Acquire(ctx, 1); err != nil {
		return "", fmt.Errorf("subagent: acquire concurrency slot: %w", err)
	}
	defer s.sem.Release(1)

	childID := fmt.Sprintf("%s.sub.%d", parentID, s.counter.Add(1))
	child := flight.New(flight.Config{
		ID:       childID,
		Engine:   s.engine,
		Store:    s.store,
		Tools:    s.tools,
		Policy:   s.policy,
		Exec:     s.exec,
		MaxSteps: s.maxSteps,
	})

	// The child runs under its own cancellable context so we can stop it once it
	// goes quiet. Cancelling ends child.Run, which closes the child's queues.
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = child.Run(childCtx)
	}()

	if err := child.Queues().Submit(childCtx, sq.Input{
		Msg:      agent.Message{Role: agent.RoleUser, Text: prompt},
		Delivery: sq.Queue,
	}); err != nil {
		return "", fmt.Errorf("subagent: submit prompt: %w", err)
	}

	summary = drainText(childCtx, child.Queues().Events())

	// Stop the child and wait for its goroutine to unwind before returning.
	cancel()
	<-runDone

	return summary, nil
}

// drainText accumulates assistant text (EvText deltas) from the child's event
// stream until the stream goes idle for drainIdle, the stream closes, or ctx is
// cancelled. The accumulated text is the summary handed back to the parent — we
// return the child's final assistant prose, not the full transcript.
func drainText(ctx context.Context, events <-chan agent.StreamEvent) string {
	var b strings.Builder
	idle := time.NewTimer(drainIdle)
	defer idle.Stop()
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return strings.TrimSpace(b.String())
			}
			if ev.Kind == agent.EvText {
				b.WriteString(ev.Text)
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(drainIdle)
		case <-idle.C:
			return strings.TrimSpace(b.String())
		case <-ctx.Done():
			return strings.TrimSpace(b.String())
		}
	}
}

// DeriveCeiling derives a child's permission ceiling from the parent's policy
// (Req 13.2). For now it returns the parent policy unchanged: the child runs
// under exactly the parent's rules.
//
// Follow-up: a finer "inherit deny only" refinement — where the child keeps the
// parent's Deny rules but must re-earn Allow capabilities within that ceiling —
// requires introspection into perm.RuleSet (enumerating its rules to project
// the Deny-only subset). perm.Policy currently exposes only Evaluate, so that
// refinement is deferred until RuleSet grows a rules accessor.
func DeriveCeiling(parent perm.Policy) perm.Policy {
	return parent
}
