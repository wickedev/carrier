package engine

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
)

// flakyEngine fails with a scripted error for the first failN calls, then
// succeeds. It also tracks peak concurrency.
type flakyEngine struct {
	failN    int32
	calls    int32
	active   int32
	maxConc  int32
	failWith *agent.EngineError
	delay    time.Duration
}

func (e *flakyEngine) Name() string { return "flaky" }

func (e *flakyEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	cur := atomic.AddInt32(&e.active, 1)
	for {
		m := atomic.LoadInt32(&e.maxConc)
		if cur <= m || atomic.CompareAndSwapInt32(&e.maxConc, m, cur) {
			break
		}
	}
	defer atomic.AddInt32(&e.active, -1)
	if e.delay > 0 {
		time.Sleep(e.delay)
	}
	n := atomic.AddInt32(&e.calls, 1)
	if n <= atomic.LoadInt32(&e.failN) {
		return agent.StepResult{}, e.failWith
	}
	return agent.StepResult{Text: "ok", Done: true}, nil
}

func TestThrottleRetriesRateLimit(t *testing.T) {
	e := &flakyEngine{failN: 2, failWith: &agent.EngineError{Class: agent.ErrRateLimited}}
	th := NewThrottle(e, 4, 5)
	th.baseDelay = time.Millisecond // fast test

	res, err := th.RunStep(context.Background(), agent.StepInput{})
	if err != nil {
		t.Fatalf("expected success after retries, got %v", err)
	}
	if !res.Done || res.Text != "ok" {
		t.Fatalf("unexpected result %+v", res)
	}
	if got := atomic.LoadInt32(&e.calls); got != 3 {
		t.Fatalf("engine called %d times, want 3 (2 fail + 1 success)", got)
	}
}

func TestThrottleDoesNotRetryFatal(t *testing.T) {
	e := &flakyEngine{failN: 10, failWith: &agent.EngineError{Class: agent.ErrFatal}}
	th := NewThrottle(e, 4, 5)
	th.baseDelay = time.Millisecond

	_, err := th.RunStep(context.Background(), agent.StepInput{})
	if err == nil {
		t.Fatal("expected fatal error to pass through")
	}
	if got := atomic.LoadInt32(&e.calls); got != 1 {
		t.Fatalf("engine called %d times, want 1 (fatal not retried)", got)
	}
}

func TestThrottleDoesNotRetryContextOverflow(t *testing.T) {
	e := &flakyEngine{failN: 10, failWith: &agent.EngineError{Class: agent.ErrContextOverflow}}
	th := NewThrottle(e, 4, 5)
	th.baseDelay = time.Millisecond

	_, err := th.RunStep(context.Background(), agent.StepInput{})
	if err == nil {
		t.Fatal("expected context-overflow to pass through (Flight handles it)")
	}
	if got := atomic.LoadInt32(&e.calls); got != 1 {
		t.Fatalf("engine called %d times, want 1 (overflow not retried here)", got)
	}
}

func TestThrottleBoundsConcurrency(t *testing.T) {
	e := &flakyEngine{delay: 15 * time.Millisecond}
	th := NewThrottle(e, 2, 0)

	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = th.RunStep(context.Background(), agent.StepInput{})
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&e.maxConc); got > 2 {
		t.Fatalf("peak concurrency %d, want <= 2", got)
	}
}

func TestThrottleHonorsContextCancel(t *testing.T) {
	e := &flakyEngine{failN: 10, failWith: &agent.EngineError{Class: agent.ErrRateLimited, RetryAfter: time.Hour}}
	th := NewThrottle(e, 1, 5)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := th.RunStep(ctx, agent.StepInput{})
	if err == nil {
		t.Fatal("expected cancellation while waiting on a long RetryAfter")
	}
}
