// Package obs implements Carrier's observability subsystem (Req 16):
// per-session/per-tenant cost accounting with cache tokens priced separately,
// a minimal context-propagated tracer with a hot-path enable guard, and a
// decision-source audit log for autonomy auditing.
//
// The package depends only on the standard library and internal/agent. The
// tracer is defined as a minimal interface so an OpenTelemetry-backed
// implementation can be plugged in later without changing call sites.
package obs

import (
	"sync"

	"github.com/wickedev/carrier/internal/agent"
)

// Price holds per-million-token (per-MTok) prices for a single model, with a
// separate rate for each token class. Cache reads and writes are priced
// independently from input/output because providers bill them differently and
// they dominate prompt-cache economics (Req 16.1).
//
// Prices are expressed in currency units per 1,000,000 tokens.
type Price struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
	// Reasoning prices reasoning/thinking tokens. Providers that bill these as
	// output may leave it zero and fold them into OutputTokens instead.
	Reasoning float64
}

// tokensPerMTok is the divisor converting raw token counts into the per-MTok
// pricing unit.
const tokensPerMTok = 1_000_000.0

// CostTable maps a model identifier to its Price. The zero value is a usable,
// empty table; cost for an unknown model is zero.
type CostTable map[string]Price

// Cost returns the monetary cost of the given usage under the model's price.
// Each token class is multiplied by its own per-MTok rate. An unknown model
// yields 0 (callers that need to detect this can use Price/lookup separately).
func (t CostTable) Cost(model string, u agent.Usage) float64 {
	p, ok := t[model]
	if !ok {
		return 0
	}
	return (float64(u.InputTokens)*p.Input +
		float64(u.OutputTokens)*p.Output +
		float64(u.CacheReadTokens)*p.CacheRead +
		float64(u.CacheWriteTokens)*p.CacheWrite +
		float64(u.ReasoningTokens)*p.Reasoning) / tokensPerMTok
}

// CostEntry is an aggregated cost+usage record for one key (session or tenant).
type CostEntry struct {
	Cost  float64
	Usage agent.Usage
}

// SnapshotData is an immutable copy of an accumulator's aggregates, safe to
// read without further locking.
type SnapshotData struct {
	Sessions map[string]CostEntry
	Tenants  map[string]CostEntry
}

// CostAccumulator aggregates cost and token usage per session and per tenant.
// It is safe for concurrent use by multiple goroutines (Req 16.2).
type CostAccumulator struct {
	table CostTable

	mu       sync.RWMutex
	sessions map[string]*CostEntry
	tenants  map[string]*CostEntry
}

// NewCostAccumulator returns an accumulator that prices usage with the given
// table. The table is read-only after construction and not copied.
func NewCostAccumulator(table CostTable) *CostAccumulator {
	return &CostAccumulator{
		table:    table,
		sessions: make(map[string]*CostEntry),
		tenants:  make(map[string]*CostEntry),
	}
}

// AddUsage prices the usage for the model and folds the resulting cost and
// token counts into both the session and tenant aggregates. Safe for
// concurrent use.
func (a *CostAccumulator) AddUsage(tenant, session, model string, u agent.Usage) {
	cost := a.table.Cost(model, u)

	a.mu.Lock()
	defer a.mu.Unlock()

	se := a.sessions[session]
	if se == nil {
		se = &CostEntry{}
		a.sessions[session] = se
	}
	se.Cost += cost
	se.Usage = se.Usage.Add(u)

	te := a.tenants[tenant]
	if te == nil {
		te = &CostEntry{}
		a.tenants[tenant] = te
	}
	te.Cost += cost
	te.Usage = te.Usage.Add(u)
}

// SessionCost returns the aggregated cost for a session (0 if unseen).
func (a *CostAccumulator) SessionCost(session string) float64 {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if e := a.sessions[session]; e != nil {
		return e.Cost
	}
	return 0
}

// TenantCost returns the aggregated cost for a tenant (0 if unseen).
func (a *CostAccumulator) TenantCost(tenant string) float64 {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if e := a.tenants[tenant]; e != nil {
		return e.Cost
	}
	return 0
}

// SessionUsage returns the aggregated token usage for a session.
func (a *CostAccumulator) SessionUsage(session string) agent.Usage {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if e := a.sessions[session]; e != nil {
		return e.Usage
	}
	return agent.Usage{}
}

// TenantUsage returns the aggregated token usage for a tenant.
func (a *CostAccumulator) TenantUsage(tenant string) agent.Usage {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if e := a.tenants[tenant]; e != nil {
		return e.Usage
	}
	return agent.Usage{}
}

// Snapshot returns an immutable, deep copy of the current aggregates. The
// returned maps are owned by the caller and never mutated by the accumulator.
func (a *CostAccumulator) Snapshot() SnapshotData {
	a.mu.RLock()
	defer a.mu.RUnlock()

	out := SnapshotData{
		Sessions: make(map[string]CostEntry, len(a.sessions)),
		Tenants:  make(map[string]CostEntry, len(a.tenants)),
	}
	for k, v := range a.sessions {
		out.Sessions[k] = *v
	}
	for k, v := range a.tenants {
		out.Tenants[k] = *v
	}
	return out
}
