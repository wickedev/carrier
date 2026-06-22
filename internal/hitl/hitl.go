// Package hitl provides a human-in-the-loop Approver implementing the
// control_request / control_response round-trip: it surfaces a pending
// permission request (keyed by a request ID) to an out-of-band channel and
// blocks the requesting tool until a decision is submitted back, a timeout
// elapses, or the context is cancelled.
package hitl

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wickedev/carrier/internal/flight"
)

// Request is a pending approval surfaced to a client (e.g. emitted over SSE).
type Request struct {
	ID       string
	Tool     string
	Resource string
	Reason   string
}

// ChannelApprover is a flight.Approver that correlates requests to responses by
// ID. onRequest delivers each request to the transport; Resolve delivers the
// decision back.
type ChannelApprover struct {
	onRequest func(Request)
	timeout   time.Duration

	mu      sync.Mutex
	pending map[string]chan bool
	seq     atomic.Uint64
}

var _ flight.Approver = (*ChannelApprover)(nil)

// New returns a ChannelApprover. onRequest is called (non-blocking expected)
// with each pending request; timeout <= 0 means wait indefinitely (until
// Resolve or ctx cancel).
func New(onRequest func(Request), timeout time.Duration) *ChannelApprover {
	return &ChannelApprover{
		onRequest: onRequest,
		timeout:   timeout,
		pending:   make(map[string]chan bool),
	}
}

// Approve implements flight.Approver. It registers a pending request, surfaces
// it, and blocks until a matching Resolve, the timeout (→ deny), or ctx cancel.
func (a *ChannelApprover) Approve(ctx context.Context, req flight.ApprovalRequest) (bool, error) {
	id := fmt.Sprintf("req-%d", a.seq.Add(1))
	ch := make(chan bool, 1)

	a.mu.Lock()
	a.pending[id] = ch
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.pending, id)
		a.mu.Unlock()
	}()

	if a.onRequest != nil {
		a.onRequest(Request{ID: id, Tool: req.Tool, Resource: req.Resource, Reason: req.Reason})
	}

	var timeout <-chan time.Time
	if a.timeout > 0 {
		t := time.NewTimer(a.timeout)
		defer t.Stop()
		timeout = t.C
	}

	select {
	case ok := <-ch:
		return ok, nil
	case <-timeout:
		return false, nil // timed out → deny
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

// Resolve answers a pending request by ID. It returns false if the ID is
// unknown (already resolved, timed out, or cancelled).
func (a *ChannelApprover) Resolve(id string, allow bool) bool {
	a.mu.Lock()
	ch, ok := a.pending[id]
	a.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- allow:
		return true
	default:
		return false
	}
}

// Pending reports how many requests are awaiting a decision.
func (a *ChannelApprover) Pending() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.pending)
}
