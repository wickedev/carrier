// Package perm implements Carrier's declarative permission model: rules of the
// form {action, resource-pattern, effect} resolved by source precedence with a
// last-match tiebreak, defaulting to "ask". Permission evaluation is kept
// independent of sandbox confinement (a confined read may still be auto-allowed
// by a rule).
package perm

// Effect is the outcome of evaluating permission for an action. Ask is the zero
// value so an unmatched action defaults to requiring approval.
type Effect int

const (
	Ask   Effect = iota // require human/automated approval (default)
	Allow               // permit silently
	Deny                // refuse immediately
)

func (e Effect) String() string {
	switch e {
	case Allow:
		return "allow"
	case Deny:
		return "deny"
	default:
		return "ask"
	}
}

// Source identifies where a rule came from. Higher values take precedence, so
// managed/policy rules override user rules, which override session rules.
type Source int

const (
	SourceSession Source = iota
	SourceUser
	SourceProject
	SourceManaged
)

func (s Source) String() string {
	switch s {
	case SourceManaged:
		return "managed"
	case SourceProject:
		return "project"
	case SourceUser:
		return "user"
	default:
		return "session"
	}
}

// Rule grants, denies, or gates an action against resources matching a pattern.
// Both Action and Pattern are wildcard globs (`*` matches any run, `?` one
// char). Action matches the tool/category name; Pattern matches the resource
// (e.g. a shell command, a URL, a file path).
type Rule struct {
	Action  string
	Pattern string
	Effect  Effect
	Source  Source
}

// DecisionReason records why a Decision was reached, for autonomy auditing.
type DecisionReason int

const (
	ReasonDefault    DecisionReason = iota // no rule matched
	ReasonRule                             // a declarative rule matched
	ReasonClassifier                       // an automated classifier decided
	ReasonHook                             // a hook decided
)

func (r DecisionReason) String() string {
	switch r {
	case ReasonRule:
		return "rule"
	case ReasonClassifier:
		return "classifier"
	case ReasonHook:
		return "hook"
	default:
		return "default"
	}
}

// Decision is the resolved permission outcome plus its provenance.
type Decision struct {
	Effect Effect
	Reason DecisionReason
	Source Source
	Rule   *Rule // the matched rule, if Reason == ReasonRule
}

// Policy evaluates permission for an (action, resource) pair.
type Policy interface {
	Evaluate(action, resource string) Decision
}

// RuleSet is the default Policy: an ordered list of rules resolved by source
// precedence (highest Source wins) with a last-match tiebreak within a source.
type RuleSet struct {
	rules []Rule
}

// NewRuleSet builds a RuleSet from the given rules (later rules win ties within
// the same source).
func NewRuleSet(rules ...Rule) *RuleSet {
	rs := &RuleSet{rules: make([]Rule, 0, len(rules))}
	rs.rules = append(rs.rules, rules...)
	return rs
}

// Add appends a rule. Within one source, a rule added later wins over an
// earlier matching rule.
func (rs *RuleSet) Add(r Rule) { rs.rules = append(rs.rules, r) }

// Evaluate resolves permission for (action, resource). Among all matching
// rules it selects the one from the highest-precedence Source; within that
// source the last-added matching rule wins. With no match it returns Ask.
func (rs *RuleSet) Evaluate(action, resource string) Decision {
	var best *Rule
	bestIdx := -1
	for i := range rs.rules {
		r := &rs.rules[i]
		if !matchGlob(r.Action, action) || !matchGlob(r.Pattern, resource) {
			continue
		}
		switch {
		case best == nil:
			best, bestIdx = r, i
		case r.Source > best.Source:
			best, bestIdx = r, i
		case r.Source == best.Source && i > bestIdx:
			best, bestIdx = r, i
		}
	}
	if best == nil {
		return Decision{Effect: Ask, Reason: ReasonDefault}
	}
	return Decision{Effect: best.Effect, Reason: ReasonRule, Source: best.Source, Rule: best}
}

// matchGlob reports whether s matches a wildcard pattern where `*` matches any
// run of characters (including the empty string and separators) and `?` matches
// exactly one character. An empty pattern matches only the empty string; `*`
// alone matches anything.
func matchGlob(pattern, s string) bool {
	// Iterative two-pointer with backtracking on `*` — linear in practice,
	// avoids the exponential blowup of naive recursion.
	var (
		p, t      int
		star      = -1
		starMatch int
	)
	for t < len(s) {
		if p < len(pattern) && (pattern[p] == '?' || pattern[p] == s[t]) {
			p++
			t++
		} else if p < len(pattern) && pattern[p] == '*' {
			star = p
			starMatch = t
			p++
		} else if star != -1 {
			p = star + 1
			starMatch++
			t = starMatch
		} else {
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}
