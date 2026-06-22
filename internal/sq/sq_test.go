package sq

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
)

func msg(text string) agent.Message {
	return agent.Message{Role: agent.RoleUser, Text: text}
}

func TestSubmitNextRoundTrip(t *testing.T) {
	q := New(4, 4, Block)
	defer q.Close()
	ctx := context.Background()

	in := Input{Msg: msg("hello"), Delivery: Queue}
	if err := q.Submit(ctx, in); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	got, ok := q.Next(ctx)
	if !ok {
		t.Fatal("Next ok=false, want true")
	}
	if got.Msg.Text != "hello" || got.Delivery != Queue {
		t.Fatalf("Next = %+v, want %+v", got, in)
	}
}

func TestSubmitFiresWake(t *testing.T) {
	q := New(4, 4, Block)
	defer q.Close()

	if err := q.Submit(context.Background(), Input{Msg: msg("x")}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	select {
	case <-q.WakeCh():
	default:
		t.Fatal("expected pending wake after Submit")
	}
}

func TestTryNextEmptyVsPending(t *testing.T) {
	q := New(4, 4, Block)
	defer q.Close()

	if _, ok := q.TryNext(); ok {
		t.Fatal("TryNext on empty SQ ok=true, want false")
	}

	if err := q.Submit(context.Background(), Input{Msg: msg("pending")}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	got, ok := q.TryNext()
	if !ok {
		t.Fatal("TryNext on pending SQ ok=false, want true")
	}
	if got.Msg.Text != "pending" {
		t.Fatalf("TryNext = %q, want %q", got.Msg.Text, "pending")
	}
	if _, ok := q.TryNext(); ok {
		t.Fatal("TryNext after drain ok=true, want false")
	}
}

func TestWakeCoalescing(t *testing.T) {
	q := New(1, 1, Block)
	defer q.Close()

	for i := 0; i < 100; i++ {
		q.Wake()
	}
	// Exactly one pending signal.
	select {
	case <-q.WakeCh():
	default:
		t.Fatal("expected one pending wake")
	}
	select {
	case <-q.WakeCh():
		t.Fatal("expected wakes to coalesce to a single signal")
	default:
	}
}

func TestWakeCoalescingConcurrent(t *testing.T) {
	q := New(1, 1, Block)
	defer q.Close()

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q.Wake()
		}()
	}
	wg.Wait()

	n := 0
	for {
		select {
		case <-q.WakeCh():
			n++
			continue
		default:
		}
		break
	}
	if n != 1 {
		t.Fatalf("pending wake signals = %d, want 1", n)
	}
}

func TestEmitBlockBackpressure(t *testing.T) {
	q := New(1, 1, Block)
	defer q.Close()
	ctx := context.Background()

	// Fill the EQ (cap 1).
	if err := q.Emit(ctx, agent.StreamEvent{Kind: agent.EvText, Text: "a"}); err != nil {
		t.Fatalf("Emit 1: %v", err)
	}

	// Second Emit must block until a consumer drains.
	emitted := make(chan error, 1)
	go func() {
		emitted <- q.Emit(ctx, agent.StreamEvent{Kind: agent.EvText, Text: "b"})
	}()

	select {
	case <-emitted:
		t.Fatal("Emit returned while EQ full, expected backpressure")
	case <-time.After(50 * time.Millisecond):
	}

	// Drain one; the blocked Emit should now proceed.
	if ev := <-q.Events(); ev.Text != "a" {
		t.Fatalf("first event = %q, want %q", ev.Text, "a")
	}
	select {
	case err := <-emitted:
		if err != nil {
			t.Fatalf("blocked Emit returned err: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Emit stayed blocked after drain")
	}
	if ev := <-q.Events(); ev.Text != "b" {
		t.Fatalf("second event = %q, want %q", ev.Text, "b")
	}
}

func TestEmitBlockContextCancel(t *testing.T) {
	q := New(1, 1, Block)
	defer q.Close()

	if err := q.Emit(context.Background(), agent.StreamEvent{Kind: agent.EvText, Text: "a"}); err != nil {
		t.Fatalf("Emit fill: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	err := q.Emit(ctx, agent.StreamEvent{Kind: agent.EvText, Text: "b"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Emit err = %v, want context.Canceled", err)
	}
}

func TestEmitShedDrop(t *testing.T) {
	q := New(1, 1, Shed)
	defer q.Close()
	ctx := context.Background()

	if err := q.Emit(ctx, agent.StreamEvent{Kind: agent.EvText, Text: "a"}); err != nil {
		t.Fatalf("Emit 1: %v", err)
	}
	// EQ full -> shed.
	err := q.Emit(ctx, agent.StreamEvent{Kind: agent.EvText, Text: "b"})
	if !errors.Is(err, ErrShed) {
		t.Fatalf("Emit on full EQ err = %v, want ErrShed", err)
	}
	// The original event survives; the shed one is gone.
	if ev := <-q.Events(); ev.Text != "a" {
		t.Fatalf("event = %q, want %q", ev.Text, "a")
	}
	select {
	case ev := <-q.Events():
		t.Fatalf("unexpected extra event %q, shed event should be dropped", ev.Text)
	default:
	}
}

func TestCloseIdempotent(t *testing.T) {
	q := New(2, 2, Block)
	q.Close()
	q.Close() // must not panic
	q.Close()
}

func TestCloseUnblocksNext(t *testing.T) {
	q := New(2, 2, Block)
	ctx := context.Background()

	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, ok := q.Next(ctx); ok {
			t.Error("Next returned ok=true after Close")
		}
	}()
	time.Sleep(20 * time.Millisecond)
	q.Close()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Next did not unblock on Close")
	}
}

func TestCloseClosesEvents(t *testing.T) {
	q := New(2, 2, Block)
	if err := q.Emit(context.Background(), agent.StreamEvent{Kind: agent.EvText, Text: "a"}); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	q.Close()

	// Ranging over Events terminates; we still receive buffered events first.
	var got []string
	for ev := range q.Events() {
		got = append(got, ev.Text)
	}
	if len(got) != 1 || got[0] != "a" {
		t.Fatalf("drained events = %v, want [a]", got)
	}
}

func TestSubmitAfterClose(t *testing.T) {
	q := New(2, 2, Block)
	q.Close()
	if err := q.Submit(context.Background(), Input{Msg: msg("x")}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit after Close err = %v, want ErrClosed", err)
	}
	if err := q.Emit(context.Background(), agent.StreamEvent{Kind: agent.EvText}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Emit after Close err = %v, want ErrClosed", err)
	}
}

// TestIdlenessRecheckRace reproduces Requirement 7.4: input may be Submitted in
// the window between the loop observing itself idle and starting a turn. The
// idempotent re-check via TryNext must catch it. We run many iterations under
// -race to exercise the window.
func TestIdlenessRecheckRace(t *testing.T) {
	for iter := 0; iter < 500; iter++ {
		q := New(4, 4, Block)
		ctx := context.Background()

		// "saw empty": the loop checked TryNext and found nothing.
		if _, ok := q.TryNext(); ok {
			q.Close()
			t.Fatal("precondition: SQ should start empty")
		}

		gate := make(chan struct{})
		var submitted atomic.Bool

		// Producer Submits during the idle->start window.
		go func() {
			<-gate
			if err := q.Submit(ctx, Input{Msg: msg("late"), Delivery: Queue}); err == nil {
				submitted.Store(true)
			}
		}()

		// Open the window, then re-check. Either the re-check sees it now, or it
		// will be visible on the very next check; in all cases no input is lost.
		close(gate)
		// Wait for the submit to land so the re-check is meaningful.
		for !submitted.Load() {
			time.Sleep(time.Microsecond)
		}
		// After a successful Submit, an idempotent re-check MUST find the input.
		if _, ok := q.TryNext(); !ok {
			q.Close()
			t.Fatalf("iter %d: idleness re-check missed queued input (race lost)", iter)
		}
		q.Close()
	}
}

func TestConcurrentProducersAndDrain(t *testing.T) {
	q := New(8, 8, Shed)
	ctx := context.Background()

	const producers = 16
	const perProducer = 200

	var emitWG sync.WaitGroup
	var emitted atomic.Int64

	// Event consumer drains until Events closes.
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		for range q.Events() {
		}
	}()

	// Inbound consumer drains submissions concurrently.
	inboundDone := make(chan struct{})
	var nexted atomic.Int64
	go func() {
		defer close(inboundDone)
		for {
			in, ok := q.Next(ctx)
			if !ok {
				return
			}
			_ = in
			nexted.Add(1)
		}
	}()

	var subWG sync.WaitGroup
	var submitted atomic.Int64
	for p := 0; p < producers; p++ {
		subWG.Add(1)
		go func() {
			defer subWG.Done()
			for i := 0; i < perProducer; i++ {
				if err := q.Submit(ctx, Input{Msg: msg("m"), Delivery: Queue}); err == nil {
					submitted.Add(1)
				}
				q.Wake()
			}
		}()
	}
	for p := 0; p < producers; p++ {
		emitWG.Add(1)
		go func() {
			defer emitWG.Done()
			for i := 0; i < perProducer; i++ {
				if err := q.Emit(ctx, agent.StreamEvent{Kind: agent.EvText, Text: "e"}); err == nil {
					emitted.Add(1)
				}
			}
		}()
	}

	subWG.Wait()
	emitWG.Wait()

	// Allow the inbound drainer to catch up before closing.
	deadline := time.Now().Add(2 * time.Second)
	for nexted.Load() < submitted.Load() && time.Now().Before(deadline) {
		q.Wake()
		time.Sleep(time.Millisecond)
	}

	q.Close()
	<-consumerDone
	<-inboundDone

	if nexted.Load() != submitted.Load() {
		t.Fatalf("drained %d inbound, submitted %d", nexted.Load(), submitted.Load())
	}
	if emitted.Load() == 0 {
		t.Fatal("no events emitted")
	}
}

func TestDeliveryString(t *testing.T) {
	if Steer.String() != "steer" || Queue.String() != "queue" {
		t.Fatalf("Delivery.String mismatch: %q %q", Steer.String(), Queue.String())
	}
	if Delivery(99).String() != "unknown" {
		t.Fatalf("unknown Delivery.String = %q", Delivery(99).String())
	}
}
