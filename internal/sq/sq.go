// Package sq implements the per-session submission (SQ) and event (EQ) queues
// that connect a Flight's goroutine to its clients.
//
// Each Flight owns one [Queues] value. Clients push inbound user input onto the
// bounded submission queue (SQ) and read streaming output from the bounded
// event queue (EQ). A coalesced wake signal lets the Flight loop park on a
// single channel and be nudged awake whenever new input may be available,
// without one wake per submission.
//
// This package only delivers and classifies input; it never interrupts a turn
// itself. Turn interruption — cancelling the active turn's context on a Steer —
// lives in the Flight loop. See [Delivery] for the steer-vs-queue contract.
package sq

import (
	"context"
	"errors"
	"sync"

	"github.com/wickedev/carrier/internal/agent"
)

// ErrShed is returned by [Queues.Emit] under [Shed] policy when the event queue
// is full and the event was dropped rather than blocking the producer.
var ErrShed = errors.New("sq: event shed, EQ full")

// ErrClosed is returned by [Queues.Submit] and [Queues.Emit] after the Queues
// have been closed.
var ErrClosed = errors.New("sq: queues closed")

// Delivery selects how a submitted [Input] is incorporated into a running
// Flight.
//
// The two semantics correspond to Requirement 7.1 (steer vs. queue):
//
//   - Steer: interrupt and redirect the active turn. The Flight loop is expected
//     to cancel the in-flight turn's context at a safe boundary and incorporate
//     the new input immediately. This package does not perform the cancellation;
//     it only carries the classification so the loop can act on it.
//   - Queue: process on the next cycle. The input waits in the SQ and is consumed
//     when the loop next checks for pending input, without disturbing the active
//     turn.
type Delivery int

const (
	// Steer interrupts and redirects the active turn (Requirement 7.1, 7.2).
	Steer Delivery = iota
	// Queue defers the input to the next loop cycle (Requirement 7.1).
	Queue
)

// String renders a Delivery for diagnostics.
func (d Delivery) String() string {
	switch d {
	case Steer:
		return "steer"
	case Queue:
		return "queue"
	default:
		return "unknown"
	}
}

// Input is one piece of inbound user input plus its delivery semantics.
//
// Model, Effort, and PlanMode are OPTIONAL per-turn overrides of the
// session-default model parameters: an empty Model or a nil Effort/PlanMode
// means "use the session default". Effort is a pointer so an EXPLICIT empty
// string (the provider's adaptive "auto" effort) can override a non-empty
// session default. They take effect for the turn sequence the input drives (the
// Flight folds them in [Flight.foldPending]).
type Input struct {
	Msg      agent.Message
	Delivery Delivery
	Model    string
	Effort   *string
	PlanMode *bool
}

// OverflowPolicy governs [Queues.Emit] behaviour when the event queue (EQ) is
// full (Requirement 2.6).
type OverflowPolicy int

const (
	// Block makes Emit apply backpressure: it blocks until space frees up or the
	// context is cancelled.
	Block OverflowPolicy = iota
	// Shed makes Emit drop the event and return ErrShed when the EQ is full,
	// never blocking the producer.
	Shed
)

// Queues is the per-session pair of bounded inbound (SQ) and outbound (EQ)
// channels with a coalesced wake signal.
//
// A Queues is safe for concurrent use by multiple producers (Submit/Emit/Wake)
// and a single consuming Flight loop (Next/TryNext/WakeCh) plus any number of
// event consumers (Events). All mutable state is either channel-resident or
// guarded, satisfying Requirement 2.7.
type Queues struct {
	sq       chan Input
	eq       chan agent.StreamEvent
	wake     chan struct{}
	eqPolicy OverflowPolicy

	// emitMu guards the EQ against the send-on-closed-channel race: emitters hold
	// it for read while sending, Close takes it for write before closing eq, so a
	// send and the close can never overlap. closed records whether Close ran.
	emitMu    sync.RWMutex
	closed    bool
	closeOnce sync.Once
	done      chan struct{}
}

// New constructs a Queues with the given SQ and EQ capacities and the given EQ
// overflow policy.
func New(sqCap, eqCap int, eqPolicy OverflowPolicy) *Queues {
	return &Queues{
		sq:       make(chan Input, sqCap),
		eq:       make(chan agent.StreamEvent, eqCap),
		wake:     make(chan struct{}, 1),
		eqPolicy: eqPolicy,
		done:     make(chan struct{}),
	}
}

// Submit enqueues inbound input, applying backpressure by blocking until there
// is room in the SQ, the context is cancelled, or the Queues are closed. On a
// successful enqueue it fires a coalesced Wake so a parked Flight loop notices
// the new input.
//
// It returns ctx.Err() if the context is cancelled before space is available,
// or ErrClosed if the Queues are closed.
func (q *Queues) Submit(ctx context.Context, in Input) error {
	// Prioritise the closed and cancelled signals: a plain three-way select would
	// pick randomly when the SQ also has room, so check them first.
	select {
	case <-q.done:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	select {
	case <-q.done:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	case q.sq <- in:
		q.Wake()
		return nil
	}
}

// Next blocks for the next inbound Input. It returns ok=false when the context
// is cancelled or the Queues are closed and drained.
func (q *Queues) Next(ctx context.Context) (Input, bool) {
	// Prefer a ready input even if the context is also done or the queue is
	// closing, so callers drain deterministically.
	select {
	case in, ok := <-q.sq:
		return in, ok
	default:
	}
	select {
	case in, ok := <-q.sq:
		return in, ok
	case <-ctx.Done():
		return Input{}, false
	case <-q.done:
		// Closed: drain any straggler that raced in before close.
		select {
		case in, ok := <-q.sq:
			return in, ok
		default:
			return Input{}, false
		}
	}
}

// TryNext performs a non-blocking inbound dequeue. It returns ok=false when the
// SQ is empty.
//
// This is the idempotent idleness re-check (Requirement 7.4): the Flight loop,
// having observed itself idle, calls TryNext just before starting a turn to
// catch input that was queued in the window between the idleness check and the
// turn start, closing the queued-input race.
func (q *Queues) TryNext() (Input, bool) {
	select {
	case in, ok := <-q.sq:
		return in, ok
	default:
		return Input{}, false
	}
}

// Wake fires the coalesced wake signal. Many concurrent Wake calls collapse into
// at most one pending signal: the wake channel is size-1 and a send that would
// block is dropped, because a pending signal already conveys "check for work".
func (q *Queues) Wake() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// WakeCh returns the coalesced wake channel the Flight loop can select on. A
// receive from it consumes the single pending signal; the loop should then
// re-check the SQ (e.g. via TryNext) for actual work.
func (q *Queues) WakeCh() <-chan struct{} {
	return q.wake
}

// Emit enqueues an outbound event onto the EQ according to the configured
// OverflowPolicy (Requirement 2.6).
//
// Under Block it blocks until there is room, the context is cancelled, or the
// Queues are closed. Under Shed it returns ErrShed immediately if the EQ is full,
// dropping the event without blocking. It returns ctx.Err() on cancellation and
// ErrClosed once closed.
func (q *Queues) Emit(ctx context.Context, ev agent.StreamEvent) error {
	// Hold the read lock across the send so Close (which takes the write lock)
	// cannot close eq mid-send. Close first closes q.done, which every send
	// selects on, so a blocked emitter releases the lock promptly on shutdown.
	q.emitMu.RLock()
	defer q.emitMu.RUnlock()
	if q.closed {
		return ErrClosed
	}
	if q.eqPolicy == Shed {
		select {
		case <-q.done:
			return ErrClosed
		case q.eq <- ev:
			return nil
		default:
			return ErrShed
		}
	}
	// Block policy.
	select {
	case <-q.done:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	case q.eq <- ev:
		return nil
	}
}

// Events returns the outbound event stream for consumers. The channel is closed
// by Close; a consumer ranging over it terminates on shutdown.
func (q *Queues) Events() <-chan agent.StreamEvent {
	return q.eq
}

// Close performs an idempotent shutdown. It unblocks any goroutine parked in
// Next, Submit, or Emit and closes the Events channel so consumers ranging over
// it terminate. Close is safe to call multiple times and from multiple
// goroutines.
func (q *Queues) Close() {
	q.closeOnce.Do(func() {
		// Signal shutdown first so any blocked emitter wakes and drops its read
		// lock, then take the write lock (now uncontended once emitters drain) and
		// close eq exactly once.
		close(q.done)
		q.emitMu.Lock()
		q.closed = true
		close(q.eq)
		q.emitMu.Unlock()
	})
}
