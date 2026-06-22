// Package tower dispatches and tracks the Fleet. It launches each Flight on its
// own goroutine, caps how many fly at once, registers them for observation, and
// cancels them on shutdown — the Carrier's flight control.
package tower

import (
	"context"
	"sync"

	"github.com/wickedev/carrier/internal/flight"
)

// Tower owns Flight lifecycles and the concurrency limit.
//
// Carrier instances are meant to be stateless: the Tower tracks only in-flight
// goroutines and a registry of live Flights. Durable session state lives in the
// Store, so any instance can be replaced or scaled horizontally.
type Tower struct {
	sem chan struct{}  // concurrency cap (a counting semaphore)
	wg  sync.WaitGroup // tracks active Flights for graceful shutdown

	mu    sync.RWMutex
	fleet map[string]*flight.Flight
}

// New builds a Tower that allows at most maxConcurrent Flights at once.
func New(maxConcurrent int) *Tower {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	return &Tower{
		sem:   make(chan struct{}, maxConcurrent),
		fleet: make(map[string]*flight.Flight),
	}
}

// Launch acquires a concurrency slot (applying backpressure when the cap is
// saturated), registers the Flight, and runs it on its own goroutine. It blocks
// only while waiting for a slot; it returns ctx.Err() if the context is
// cancelled before a slot is acquired.
//
// The Flight runs under ctx; cancel it (or call Shutdown) to stop the Flight.
func (t *Tower) Launch(ctx context.Context, f *flight.Flight) error {
	select {
	case t.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}

	t.register(f)
	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		defer t.unregister(f.ID())
		defer func() { <-t.sem }()
		_ = f.Run(ctx)
	}()
	return nil
}

// Get returns the live Flight with the given ID, if any.
func (t *Tower) Get(id string) (*flight.Flight, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	f, ok := t.fleet[id]
	return f, ok
}

// Active reports how many Flights are currently registered.
func (t *Tower) Active() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.fleet)
}

// Wait blocks until every in-flight Flight has finished. Cancel the context
// passed to Launch first (or use Shutdown) to ask them to stop.
func (t *Tower) Wait() { t.wg.Wait() }

func (t *Tower) register(f *flight.Flight) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.fleet[f.ID()] = f
}

func (t *Tower) unregister(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.fleet, id)
}
