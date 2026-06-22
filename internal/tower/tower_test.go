package tower

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/engine"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tool"
)

// mkFlight builds a Flight that blocks waiting for input (none is submitted), so
// it stays alive until its context is cancelled — no model call is made.
func mkFlight(t *testing.T, id string) *flight.Flight {
	t.Helper()
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	return flight.New(flight.Config{
		ID:     id,
		Engine: engine.NewAnthropicEngine(),
		Store:  st,
		Tools:  tool.NewRegistry(),
	})
}

func TestTowerLaunchRegistersAndShutsDown(t *testing.T) {
	tw := New(8)
	ctx, cancel := context.WithCancel(context.Background())

	const n = 5
	for i := 0; i < n; i++ {
		if err := tw.Launch(ctx, mkFlight(t, fmt.Sprintf("f%d", i))); err != nil {
			t.Fatalf("launch %d: %v", i, err)
		}
	}
	if got := tw.Active(); got != n {
		t.Fatalf("Active() = %d, want %d", got, n)
	}
	if _, ok := tw.Get("f2"); !ok {
		t.Fatal("expected f2 in the fleet")
	}

	cancel()
	tw.Wait()
	if got := tw.Active(); got != 0 {
		t.Fatalf("after shutdown Active() = %d, want 0", got)
	}
}

func TestTowerBackpressureRespectsContext(t *testing.T) {
	tw := New(1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// First launch takes the only slot; the Flight blocks on input.
	if err := tw.Launch(ctx, mkFlight(t, "a")); err != nil {
		t.Fatalf("first launch: %v", err)
	}

	// Second launch must block for a slot and then fail when its context expires.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	start := time.Now()
	err := tw.Launch(ctx2, mkFlight(t, "b"))
	if err == nil {
		t.Fatal("expected Launch to fail under backpressure when context expires")
	}
	if time.Since(start) < 80*time.Millisecond {
		t.Fatalf("Launch returned too quickly (%v); expected it to block on the slot", time.Since(start))
	}
	if tw.Active() != 1 {
		t.Fatalf("Active() = %d, want 1 (second launch should not register)", tw.Active())
	}
}
