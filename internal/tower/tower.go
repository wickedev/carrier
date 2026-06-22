// Package tower dispatches and tracks the Fleet. It launches each Flight on its
// own goroutine, caps how many fly at once, and lets them be cancelled on
// shutdown — the Carrier's flight control.
package tower

import (
	"context"
	"sync"

	"github.com/wickedev/carrier/internal/flight"
)

// Tower owns Flight lifecycles and the concurrency limit.
//
// Carrier instances are meant to be stateless: the Tower tracks only in-flight
// goroutines. Durable session state belongs in Postgres/Redis so any instance
// can be replaced or scaled horizontally.
type Tower struct {
	sem chan struct{}  // concurrency cap (a counting semaphore)
	wg  sync.WaitGroup // tracks active Flights for graceful shutdown
}

// New builds a Tower that allows at most maxConcurrent Flights at once.
func New(maxConcurrent int) *Tower {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	return &Tower{sem: make(chan struct{}, maxConcurrent)}
}

// Result carries a finished Flight's outcome back to the caller.
type Result struct {
	Output string
	Err    error
}

// Launch starts a Flight on its own goroutine and returns a channel that
// delivers the result exactly once. It blocks only while the concurrency cap is
// saturated (backpressure), or until ctx is cancelled while waiting for a slot.
func (t *Tower) Launch(ctx context.Context, f *flight.Flight, task string) <-chan Result {
	out := make(chan Result, 1)

	// Acquire a slot, or bail out if cancelled while waiting.
	select {
	case t.sem <- struct{}{}:
	case <-ctx.Done():
		out <- Result{Err: ctx.Err()}
		close(out)
		return out
	}

	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		defer func() { <-t.sem }() // release the slot
		defer close(out)

		s, err := f.Run(ctx, task)
		out <- Result{Output: s, Err: err}
	}()

	return out
}

// Wait blocks until every in-flight Flight has finished. Cancel the context you
// passed to Launch first to ask them to stop.
func (t *Tower) Wait() { t.wg.Wait() }
