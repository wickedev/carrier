package perm

import (
	"context"
	"sync"
)

// Classifier auto-decides Ask-effect permission requests on a sanitized
// projection of the request (action + resource only — never the full,
// possibly-hostile tool input). It runs off the streaming hot path (during
// post-turn tool dispatch). A return of Ask means "no opinion; escalate".
type Classifier interface {
	Classify(ctx context.Context, action, resource string) (Effect, error)
}

// DenialTracker counts consecutive automated denials per scope so a noisy or
// mis-calibrated classifier falls back to explicit human approval rather than
// silently blocking the user's intent.
type DenialTracker struct {
	mu          sync.Mutex
	consecutive int
	threshold   int
}

// NewDenialTracker returns a tracker that signals fallback after `threshold`
// consecutive denials (threshold <= 0 → never falls back).
func NewDenialTracker(threshold int) *DenialTracker {
	return &DenialTracker{threshold: threshold}
}

// Record notes whether the latest automated decision was a denial and reports
// whether the consecutive-denial threshold has been reached (time to fall back
// to human approval). A non-denial resets the streak.
func (d *DenialTracker) Record(denied bool) (fallback bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !denied {
		d.consecutive = 0
		return false
	}
	d.consecutive++
	return d.threshold > 0 && d.consecutive >= d.threshold
}

// Reset clears the denial streak.
func (d *DenialTracker) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.consecutive = 0
}
