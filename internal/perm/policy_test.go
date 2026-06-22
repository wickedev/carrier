package perm

import "testing"

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		pattern, s string
		want       bool
	}{
		{"*", "anything", true},
		{"*", "", true},
		{"", "", true},
		{"", "x", false},
		{"git *", "git status", true},
		{"git *", "git", false},
		{"git*", "git", true},
		{"Bash", "Bash", true},
		{"Bash", "bash", false},
		{"domain:*", "domain:example.com", true},
		{"*.go", "main.go", true},
		{"*.go", "main.rs", false},
		{"a?c", "abc", true},
		{"a?c", "ac", false},
		{"/a/*/c", "/a/b/c", true},
		{"foo*bar", "fooXYZbar", true},
		{"foo*bar", "foobaz", false},
	}
	for _, c := range cases {
		if got := matchGlob(c.pattern, c.s); got != c.want {
			t.Errorf("matchGlob(%q, %q) = %v, want %v", c.pattern, c.s, got, c.want)
		}
	}
}

func TestEvaluateDefaultAsk(t *testing.T) {
	rs := NewRuleSet()
	d := rs.Evaluate("Bash", "rm -rf /")
	if d.Effect != Ask || d.Reason != ReasonDefault {
		t.Fatalf("got %+v, want Ask/default", d)
	}
}

func TestEvaluateRuleMatch(t *testing.T) {
	rs := NewRuleSet(
		Rule{Action: "Bash", Pattern: "git *", Effect: Allow, Source: SourceUser},
	)
	d := rs.Evaluate("Bash", "git status")
	if d.Effect != Allow || d.Reason != ReasonRule || d.Source != SourceUser {
		t.Fatalf("got %+v, want Allow/rule/user", d)
	}
	// Non-matching resource falls through to default Ask.
	if d := rs.Evaluate("Bash", "rm file"); d.Effect != Ask {
		t.Fatalf("got %+v, want Ask", d)
	}
}

func TestEvaluateSourcePrecedence(t *testing.T) {
	// User allows; managed denies the same action — managed wins.
	rs := NewRuleSet(
		Rule{Action: "Bash", Pattern: "*", Effect: Allow, Source: SourceUser},
		Rule{Action: "Bash", Pattern: "*", Effect: Deny, Source: SourceManaged},
	)
	d := rs.Evaluate("Bash", "anything")
	if d.Effect != Deny || d.Source != SourceManaged {
		t.Fatalf("got %+v, want Deny/managed (managed overrides user)", d)
	}
}

func TestEvaluateLastMatchWithinSource(t *testing.T) {
	// Two user rules match; the later one wins.
	rs := NewRuleSet(
		Rule{Action: "Bash", Pattern: "git *", Effect: Deny, Source: SourceUser},
		Rule{Action: "Bash", Pattern: "git push*", Effect: Allow, Source: SourceUser},
	)
	if d := rs.Evaluate("Bash", "git push origin"); d.Effect != Allow {
		t.Fatalf("got %+v, want Allow (last match within source wins)", d)
	}
	// A command matched only by the earlier rule keeps its effect.
	if d := rs.Evaluate("Bash", "git status"); d.Effect != Deny {
		t.Fatalf("got %+v, want Deny", d)
	}
}

func TestEvaluateWildcardAction(t *testing.T) {
	rs := NewRuleSet(
		Rule{Action: "*", Pattern: "*", Effect: Allow, Source: SourceSession},
	)
	if d := rs.Evaluate("WebFetch", "https://example.com"); d.Effect != Allow {
		t.Fatalf("got %+v, want Allow", d)
	}
}
