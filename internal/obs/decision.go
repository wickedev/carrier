package obs

import (
	"sync"
	"time"
)

// DecisionSource identifies what authorized a tool decision, for autonomy
// auditing (Req 16.4).
type DecisionSource int

const (
	// SourceUser is an explicit human approval.
	SourceUser DecisionSource = iota
	// SourceRule is a static policy/allowlist rule.
	SourceRule
	// SourceClassifier is an ML/heuristic classifier verdict.
	SourceClassifier
	// SourceHook is a programmatic hook decision.
	SourceHook
)

// String returns the lowercase source name used in audit output.
func (s DecisionSource) String() string {
	switch s {
	case SourceUser:
		return "user"
	case SourceRule:
		return "rule"
	case SourceClassifier:
		return "classifier"
	case SourceHook:
		return "hook"
	default:
		return "unknown"
	}
}

// Decision is one recorded tool-authorization event.
type Decision struct {
	Session string
	Tool    string
	Source  DecisionSource
	At      time.Time
}

// DecisionLog is a concurrency-safe, queryable sink of tool decisions.
type DecisionLog struct {
	// now is overridable for deterministic tests; defaults to time.Now.
	now func() time.Time

	mu      sync.RWMutex
	entries []Decision
}

// NewDecisionLog returns an empty decision log.
func NewDecisionLog() *DecisionLog {
	return &DecisionLog{now: time.Now}
}

// RecordDecision appends a decision for the given session and tool with its
// source. Safe for concurrent use.
func (l *DecisionLog) RecordDecision(session, tool string, src DecisionSource) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, Decision{
		Session: session,
		Tool:    tool,
		Source:  src,
		At:      l.now(),
	})
}

// All returns a copy of every recorded decision in record order.
func (l *DecisionLog) All() []Decision {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]Decision, len(l.entries))
	copy(out, l.entries)
	return out
}

// BySession returns the decisions recorded for one session, in record order.
func (l *DecisionLog) BySession(session string) []Decision {
	l.mu.RLock()
	defer l.mu.RUnlock()
	var out []Decision
	for _, d := range l.entries {
		if d.Session == session {
			out = append(out, d)
		}
	}
	return out
}

// CountBySource tallies recorded decisions by source across all sessions.
func (l *DecisionLog) CountBySource() map[DecisionSource]int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make(map[DecisionSource]int)
	for _, d := range l.entries {
		out[d.Source]++
	}
	return out
}
