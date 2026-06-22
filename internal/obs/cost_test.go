package obs

import (
	"math"
	"sync"
	"testing"

	"github.com/wickedev/carrier/internal/agent"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func testTable() CostTable {
	return CostTable{
		"m1": {
			Input:      3,    // $3 / MTok
			Output:     15,   // $15 / MTok
			CacheRead:  0.30, // $0.30 / MTok
			CacheWrite: 3.75, // $3.75 / MTok
			Reasoning:  15,
		},
	}
}

func TestCostTable_CacheTokensPricedSeparately(t *testing.T) {
	tbl := testTable()
	u := agent.Usage{
		InputTokens:      1_000_000,
		OutputTokens:     1_000_000,
		CacheReadTokens:  1_000_000,
		CacheWriteTokens: 1_000_000,
		ReasoningTokens:  1_000_000,
	}
	// Each class is one full MTok, so cost equals the sum of the rates.
	want := 3 + 15 + 0.30 + 3.75 + 15
	if got := tbl.Cost("m1", u); !approx(got, want) {
		t.Fatalf("Cost = %v, want %v", got, want)
	}

	// Cache reads must not be priced at the input rate: 2 MTok cache-read
	// costs 0.60, not 6.
	cacheOnly := agent.Usage{CacheReadTokens: 2_000_000}
	if got := tbl.Cost("m1", cacheOnly); !approx(got, 0.60) {
		t.Fatalf("cache-read Cost = %v, want 0.60", got)
	}

	// Cache write priced at its own rate.
	writeOnly := agent.Usage{CacheWriteTokens: 1_000_000}
	if got := tbl.Cost("m1", writeOnly); !approx(got, 3.75) {
		t.Fatalf("cache-write Cost = %v, want 3.75", got)
	}
}

func TestCostTable_UnknownModelZero(t *testing.T) {
	tbl := testTable()
	if got := tbl.Cost("nope", agent.Usage{InputTokens: 1_000_000}); got != 0 {
		t.Fatalf("unknown model Cost = %v, want 0", got)
	}
}

func TestCostTable_FractionalTokens(t *testing.T) {
	tbl := testTable()
	// 500k input @ $3/MTok = $1.50
	if got := tbl.Cost("m1", agent.Usage{InputTokens: 500_000}); !approx(got, 1.50) {
		t.Fatalf("Cost = %v, want 1.50", got)
	}
}

func TestAccumulator_Aggregation(t *testing.T) {
	acc := NewCostAccumulator(testTable())
	u := agent.Usage{InputTokens: 1_000_000} // $3 each

	acc.AddUsage("tenantA", "s1", "m1", u)
	acc.AddUsage("tenantA", "s1", "m1", u)
	acc.AddUsage("tenantA", "s2", "m1", u)
	acc.AddUsage("tenantB", "s3", "m1", u)

	if got := acc.SessionCost("s1"); !approx(got, 6) {
		t.Fatalf("SessionCost(s1) = %v, want 6", got)
	}
	if got := acc.SessionCost("s2"); !approx(got, 3) {
		t.Fatalf("SessionCost(s2) = %v, want 3", got)
	}
	if got := acc.TenantCost("tenantA"); !approx(got, 9) {
		t.Fatalf("TenantCost(tenantA) = %v, want 9", got)
	}
	if got := acc.TenantCost("tenantB"); !approx(got, 3) {
		t.Fatalf("TenantCost(tenantB) = %v, want 3", got)
	}

	if got := acc.SessionUsage("s1").InputTokens; got != 2_000_000 {
		t.Fatalf("SessionUsage(s1).InputTokens = %d, want 2000000", got)
	}

	snap := acc.Snapshot()
	if len(snap.Sessions) != 3 {
		t.Fatalf("snapshot sessions = %d, want 3", len(snap.Sessions))
	}
	if len(snap.Tenants) != 2 {
		t.Fatalf("snapshot tenants = %d, want 2", len(snap.Tenants))
	}
	if !approx(snap.Tenants["tenantA"].Cost, 9) {
		t.Fatalf("snapshot tenantA cost = %v, want 9", snap.Tenants["tenantA"].Cost)
	}
}

func TestAccumulator_SnapshotIsolated(t *testing.T) {
	acc := NewCostAccumulator(testTable())
	acc.AddUsage("t", "s", "m1", agent.Usage{InputTokens: 1_000_000})
	snap := acc.Snapshot()
	// Mutating the snapshot must not affect the accumulator.
	e := snap.Sessions["s"]
	e.Cost = 999
	snap.Sessions["s"] = e
	if got := acc.SessionCost("s"); !approx(got, 3) {
		t.Fatalf("accumulator mutated via snapshot: SessionCost = %v, want 3", got)
	}
}

func TestAccumulator_ConcurrentAddUsage(t *testing.T) {
	acc := NewCostAccumulator(testTable())
	u := agent.Usage{InputTokens: 1_000_000} // $3 each

	const goroutines = 50
	const perG = 200

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for g := 0; g < goroutines; g++ {
		go func() {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				acc.AddUsage("tenant", "session", "m1", u)
			}
		}()
	}
	wg.Wait()

	wantCost := float64(goroutines*perG) * 3
	if got := acc.SessionCost("session"); !approx(got, wantCost) {
		t.Fatalf("SessionCost = %v, want %v", got, wantCost)
	}
	if got := acc.TenantCost("tenant"); !approx(got, wantCost) {
		t.Fatalf("TenantCost = %v, want %v", got, wantCost)
	}
	wantTokens := goroutines * perG * 1_000_000
	if got := acc.TenantUsage("tenant").InputTokens; got != wantTokens {
		t.Fatalf("TenantUsage.InputTokens = %d, want %d", got, wantTokens)
	}
}
