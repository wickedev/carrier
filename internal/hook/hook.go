// Package hook implements Carrier's lifecycle Hooks subsystem (Req 12).
//
// Hooks are typed extension points into the Flight loop. They run as a typed
// middleware chain that returns new values rather than mutating shared state in
// place: each hook receives an immutable input and returns an outcome, and the
// Registry threads the (possibly rewritten) value through the next hook. This
// lets policy, audit, and context injection happen without touching the loop.
//
// Trust is layered. A hook declares the configuration Layer it came from. Only
// the user and session layers may register trusted hooks; project- and
// plugin-supplied configuration cannot grant its own trust, so a project/plugin
// hook added with Trust=true is forced to untrusted on registration.
//
// Only Go-func hooks are modeled here; the design's shell/command hooks are out
// of scope for this package.
package hook

import "context"

// EventKind identifies a lifecycle point at which hooks may run.
type EventKind int

const (
	// PreToolUse runs before a tool executes; may block, rewrite input, or
	// append context.
	PreToolUse EventKind = iota
	// PostToolUse runs after a tool executes; may append context.
	PostToolUse
	// SessionStart runs when a session begins.
	SessionStart
	// SessionEnd runs when a session ends.
	SessionEnd
	// PreCompact runs before history compaction.
	PreCompact
	// PostCompact runs after history compaction.
	PostCompact
)

// String renders an EventKind for logs and diagnostics.
func (k EventKind) String() string {
	switch k {
	case PreToolUse:
		return "PreToolUse"
	case PostToolUse:
		return "PostToolUse"
	case SessionStart:
		return "SessionStart"
	case SessionEnd:
		return "SessionEnd"
	case PreCompact:
		return "PreCompact"
	case PostCompact:
		return "PostCompact"
	default:
		return "Unknown"
	}
}

// Layer identifies which configuration source supplied a hook. The layer
// governs whether the hook may be trusted: only LayerUser and LayerSession may
// carry trust.
type Layer int

const (
	// LayerSession is configuration scoped to a single live session.
	LayerSession Layer = iota
	// LayerUser is the operator's own configuration.
	LayerUser
	// LayerProject is configuration checked into a project repo.
	LayerProject
	// LayerPlugin is configuration supplied by an installed plugin.
	LayerPlugin
)

// String renders a Layer for logs and diagnostics.
func (l Layer) String() string {
	switch l {
	case LayerSession:
		return "session"
	case LayerUser:
		return "user"
	case LayerProject:
		return "project"
	case LayerPlugin:
		return "plugin"
	default:
		return "unknown"
	}
}

// trustableLayer reports whether a layer is permitted to register trusted
// hooks. Project and plugin configuration cannot grant its own trust (Req 12.5).
func trustableLayer(l Layer) bool {
	return l == LayerUser || l == LayerSession
}

// PreToolUseInput is the immutable input to a PreToolUse hook.
type PreToolUseInput struct {
	ToolName string
	Input    map[string]any
}

// PreToolUseOutcome is what a PreToolUse hook returns.
//
// A non-empty RewrittenInput replaces the tool input threaded into subsequent
// hooks (and ultimately the tool). Block short-circuits the chain and prevents
// the tool from running, surfacing Reason. AppendContext accumulates across
// hooks.
type PreToolUseOutcome struct {
	Block          bool
	Reason         string
	RewrittenInput map[string]any
	AppendContext  string
}

// PostToolUseInput is the immutable input to a PostToolUse hook.
type PostToolUseInput struct {
	ToolName string
	Result   string
	IsError  bool
}

// PostToolUseOutcome is what a PostToolUse hook returns.
type PostToolUseOutcome struct {
	AppendContext string
}

// SessionStartInput is the immutable input to a SessionStart hook.
type SessionStartInput struct {
	SessionID string
}

// SessionStartOutcome is what a SessionStart hook returns.
type SessionStartOutcome struct {
	AppendContext string
}

// SessionEndInput is the immutable input to a SessionEnd hook.
type SessionEndInput struct {
	SessionID string
	Reason    string
}

// SessionEndOutcome is what a SessionEnd hook returns.
type SessionEndOutcome struct {
	AppendContext string
}

// PreCompactInput is the immutable input to a PreCompact hook.
type PreCompactInput struct {
	SessionID    string
	MessageCount int
}

// PreCompactOutcome is what a PreCompact hook returns.
type PreCompactOutcome struct {
	AppendContext string
}

// PostCompactInput is the immutable input to a PostCompact hook.
type PostCompactInput struct {
	SessionID    string
	MessageCount int
}

// PostCompactOutcome is what a PostCompact hook returns.
type PostCompactOutcome struct {
	AppendContext string
}

// Hook function signatures. Each is a pure-ish Go func that takes a context and
// an immutable input and returns a typed outcome (return-new, not in-place).
type (
	// PreToolUseFunc handles a PreToolUse event.
	PreToolUseFunc func(ctx context.Context, in PreToolUseInput) (PreToolUseOutcome, error)
	// PostToolUseFunc handles a PostToolUse event.
	PostToolUseFunc func(ctx context.Context, in PostToolUseInput) (PostToolUseOutcome, error)
	// SessionStartFunc handles a SessionStart event.
	SessionStartFunc func(ctx context.Context, in SessionStartInput) (SessionStartOutcome, error)
	// SessionEndFunc handles a SessionEnd event.
	SessionEndFunc func(ctx context.Context, in SessionEndInput) (SessionEndOutcome, error)
	// PreCompactFunc handles a PreCompact event.
	PreCompactFunc func(ctx context.Context, in PreCompactInput) (PreCompactOutcome, error)
	// PostCompactFunc handles a PostCompact event.
	PostCompactFunc func(ctx context.Context, in PostCompactInput) (PostCompactOutcome, error)
)
