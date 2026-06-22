package engine

import (
	"context"
	"errors"
	"time"

	"golang.org/x/sync/semaphore"

	"github.com/wickedev/carrier/internal/agent"
)

// Throttle wraps an Engine with a per-engine concurrency cap and automatic
// retry of transient failures (rate limits, retryable server errors), honoring
// RetryAfter. It protects a many-session server from 429 storms against one
// provider. Context-overflow is NOT retried here — the Flight loop recovers from
// it via compaction — so it passes straight through.
type Throttle struct {
	eng        Engine
	sem        *semaphore.Weighted
	maxRetries int
	baseDelay  time.Duration
	maxDelay   time.Duration
}

// NewThrottle bounds concurrent RunStep calls to maxConcurrent and retries
// transient errors up to maxRetries times.
func NewThrottle(eng Engine, maxConcurrent, maxRetries int) *Throttle {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	if maxRetries < 0 {
		maxRetries = 0
	}
	return &Throttle{
		eng:        eng,
		sem:        semaphore.NewWeighted(int64(maxConcurrent)),
		maxRetries: maxRetries,
		baseDelay:  250 * time.Millisecond,
		maxDelay:   30 * time.Second,
	}
}

// Name implements Engine.
func (t *Throttle) Name() string { return t.eng.Name() }

// RunStep implements Engine, acquiring a concurrency slot and retrying transient
// failures with backoff.
func (t *Throttle) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	for attempt := 0; ; attempt++ {
		if err := t.sem.Acquire(ctx, 1); err != nil {
			return agent.StepResult{}, err
		}
		res, err := t.eng.RunStep(ctx, in)
		t.sem.Release(1)

		if err == nil {
			return res, nil
		}
		if !t.shouldRetry(err) || attempt >= t.maxRetries {
			return res, err
		}
		if werr := t.wait(ctx, attempt, err); werr != nil {
			return res, werr
		}
	}
}

// shouldRetry reports whether an error is a transient failure worth retrying at
// this layer. Context-overflow is excluded (the Flight compacts and retries it).
func (t *Throttle) shouldRetry(err error) bool {
	var ee *agent.EngineError
	if !errors.As(err, &ee) {
		return false
	}
	return ee.Class == agent.ErrRateLimited || ee.Class == agent.ErrRetryable
}

// wait sleeps for the backoff interval (honoring RetryAfter when present) or
// returns ctx.Err() if the context is cancelled first.
func (t *Throttle) wait(ctx context.Context, attempt int, err error) error {
	delay := t.backoff(attempt)
	var ee *agent.EngineError
	if errors.As(err, &ee) && ee.RetryAfter > delay {
		delay = ee.RetryAfter
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// backoff returns an exponential delay capped at maxDelay.
func (t *Throttle) backoff(attempt int) time.Duration {
	d := t.baseDelay << attempt
	if d <= 0 || d > t.maxDelay {
		return t.maxDelay
	}
	return d
}
