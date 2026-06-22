package obs

import (
	"testing"
)

func TestDecisionSource_String(t *testing.T) {
	cases := map[DecisionSource]string{
		SourceUser:         "user",
		SourceRule:         "rule",
		SourceClassifier:   "classifier",
		SourceHook:         "hook",
		DecisionSource(99): "unknown",
	}
	for src, want := range cases {
		if got := src.String(); got != want {
			t.Fatalf("%d.String() = %q, want %q", src, got, want)
		}
	}
}

func TestDecisionLog_RecordAndQuery(t *testing.T) {
	log := NewDecisionLog()

	log.RecordDecision("s1", "bash", SourceUser)
	log.RecordDecision("s1", "read", SourceRule)
	log.RecordDecision("s2", "bash", SourceClassifier)
	log.RecordDecision("s1", "write", SourceHook)

	all := log.All()
	if len(all) != 4 {
		t.Fatalf("All() = %d entries, want 4", len(all))
	}
	if all[0].Session != "s1" || all[0].Tool != "bash" || all[0].Source != SourceUser {
		t.Fatalf("first entry = %+v", all[0])
	}
	if all[0].At.IsZero() {
		t.Fatalf("decision timestamp not set")
	}

	s1 := log.BySession("s1")
	if len(s1) != 3 {
		t.Fatalf("BySession(s1) = %d, want 3", len(s1))
	}
	for _, d := range s1 {
		if d.Session != "s1" {
			t.Fatalf("BySession(s1) returned %q", d.Session)
		}
	}

	counts := log.CountBySource()
	if counts[SourceUser] != 1 || counts[SourceRule] != 1 ||
		counts[SourceClassifier] != 1 || counts[SourceHook] != 1 {
		t.Fatalf("CountBySource = %v", counts)
	}
}

func TestDecisionLog_AllIsolated(t *testing.T) {
	log := NewDecisionLog()
	log.RecordDecision("s1", "bash", SourceUser)
	out := log.All()
	out[0].Tool = "mutated"
	if got := log.All()[0].Tool; got != "bash" {
		t.Fatalf("internal log mutated via All(): tool = %q", got)
	}
}
