package hook

import "context"

// Hook is a single registered handler for one event kind.
//
// Exactly one of the Fn fields is set, matching Event. Trust marks the hook as
// allowed to take privileged outcomes; it is only honored for user/session
// layers (see Registry.register). Layer records the configuration source.
type Hook struct {
	Name  string
	Event EventKind
	Layer Layer
	Trust bool

	preTool      PreToolUseFunc
	postTool     PostToolUseFunc
	sessionStart SessionStartFunc
	sessionEnd   SessionEndFunc
	preCompact   PreCompactFunc
	postCompact  PostCompactFunc
}

// Trusted reports the effective trust of a registered hook (after demotion).
func (h Hook) Trusted() bool { return h.Trust }

// Registry holds the ordered hook chains for each event kind and runs them.
//
// Registration order is preserved per event: the chain runs in the order hooks
// were added. The zero Registry is ready to use.
type Registry struct {
	preTool      []Hook
	postTool     []Hook
	sessionStart []Hook
	sessionEnd   []Hook
	preCompact   []Hook
	postCompact  []Hook
}

// NewRegistry returns an empty Registry.
func NewRegistry() *Registry { return &Registry{} }

// enforceTrust applies the cross-cutting trust-demotion invariant (Req 12.5):
// a hook from a non-trustable layer (project/plugin) cannot carry trust, so its
// Trust flag is forced off. The typed Add* callers set Event and pick the chain.
func enforceTrust(h *Hook) {
	if h.Trust && !trustableLayer(h.Layer) {
		// Project/plugin config cannot grant its own trust.
		h.Trust = false
	}
}

// AddPreToolUse registers a PreToolUse hook. If layer is project/plugin and
// trust is true, the hook is demoted to untrusted.
func (r *Registry) AddPreToolUse(name string, layer Layer, trust bool, fn PreToolUseFunc) {
	h := Hook{Name: name, Event: PreToolUse, Layer: layer, Trust: trust, preTool: fn}
	enforceTrust(&h)
	r.preTool = append(r.preTool, h)
}

// AddPostToolUse registers a PostToolUse hook.
func (r *Registry) AddPostToolUse(name string, layer Layer, trust bool, fn PostToolUseFunc) {
	h := Hook{Name: name, Event: PostToolUse, Layer: layer, Trust: trust, postTool: fn}
	enforceTrust(&h)
	r.postTool = append(r.postTool, h)
}

// AddSessionStart registers a SessionStart hook.
func (r *Registry) AddSessionStart(name string, layer Layer, trust bool, fn SessionStartFunc) {
	h := Hook{Name: name, Event: SessionStart, Layer: layer, Trust: trust, sessionStart: fn}
	enforceTrust(&h)
	r.sessionStart = append(r.sessionStart, h)
}

// AddSessionEnd registers a SessionEnd hook.
func (r *Registry) AddSessionEnd(name string, layer Layer, trust bool, fn SessionEndFunc) {
	h := Hook{Name: name, Event: SessionEnd, Layer: layer, Trust: trust, sessionEnd: fn}
	enforceTrust(&h)
	r.sessionEnd = append(r.sessionEnd, h)
}

// AddPreCompact registers a PreCompact hook.
func (r *Registry) AddPreCompact(name string, layer Layer, trust bool, fn PreCompactFunc) {
	h := Hook{Name: name, Event: PreCompact, Layer: layer, Trust: trust, preCompact: fn}
	enforceTrust(&h)
	r.preCompact = append(r.preCompact, h)
}

// AddPostCompact registers a PostCompact hook.
func (r *Registry) AddPostCompact(name string, layer Layer, trust bool, fn PostCompactFunc) {
	h := Hook{Name: name, Event: PostCompact, Layer: layer, Trust: trust, postCompact: fn}
	enforceTrust(&h)
	r.postCompact = append(r.postCompact, h)
}

// Hooks returns the registered hooks for an event kind, in chain order. The
// returned slice is a copy; callers may inspect it freely.
func (r *Registry) Hooks(kind EventKind) []Hook {
	switch kind {
	case PreToolUse:
		return append([]Hook(nil), r.preTool...)
	case PostToolUse:
		return append([]Hook(nil), r.postTool...)
	case SessionStart:
		return append([]Hook(nil), r.sessionStart...)
	case SessionEnd:
		return append([]Hook(nil), r.sessionEnd...)
	case PreCompact:
		return append([]Hook(nil), r.preCompact...)
	case PostCompact:
		return append([]Hook(nil), r.postCompact...)
	default:
		return nil
	}
}

// joinContext appends a fragment to an accumulating context string, separating
// non-empty fragments with a newline so multiple hooks' context stacks readably.
func joinContext(acc, frag string) string {
	if frag == "" {
		return acc
	}
	if acc == "" {
		return frag
	}
	return acc + "\n" + frag
}

// RunPreToolUse runs the PreToolUse chain over in.
//
// Each hook sees the value as rewritten by earlier hooks: a non-empty
// RewrittenInput replaces the input threaded forward. AppendContext from every
// hook accumulates into the final outcome. The first hook that returns Block
// short-circuits the chain — later hooks do not run — and the returned outcome
// carries that Block, its Reason, the accumulated context so far, and the
// last-threaded input. Any hook error aborts the chain and is returned.
func (r *Registry) RunPreToolUse(ctx context.Context, in PreToolUseInput) (PreToolUseOutcome, error) {
	cur := in
	var acc string

	for _, h := range r.preTool {
		out, err := h.preTool(ctx, cur)
		if err != nil {
			return PreToolUseOutcome{}, err
		}
		acc = joinContext(acc, out.AppendContext)

		if out.Block {
			return PreToolUseOutcome{
				Block:          true,
				Reason:         out.Reason,
				RewrittenInput: cur.Input,
				AppendContext:  acc,
			}, nil
		}
		if out.RewrittenInput != nil {
			cur = PreToolUseInput{ToolName: cur.ToolName, Input: out.RewrittenInput}
		}
	}

	return PreToolUseOutcome{
		RewrittenInput: cur.Input,
		AppendContext:  acc,
	}, nil
}

// RunPostToolUse runs the PostToolUse chain, accumulating AppendContext.
func (r *Registry) RunPostToolUse(ctx context.Context, in PostToolUseInput) (PostToolUseOutcome, error) {
	var acc string
	for _, h := range r.postTool {
		out, err := h.postTool(ctx, in)
		if err != nil {
			return PostToolUseOutcome{}, err
		}
		acc = joinContext(acc, out.AppendContext)
	}
	return PostToolUseOutcome{AppendContext: acc}, nil
}

// RunSessionStart runs the SessionStart chain, accumulating AppendContext.
func (r *Registry) RunSessionStart(ctx context.Context, in SessionStartInput) (SessionStartOutcome, error) {
	var acc string
	for _, h := range r.sessionStart {
		out, err := h.sessionStart(ctx, in)
		if err != nil {
			return SessionStartOutcome{}, err
		}
		acc = joinContext(acc, out.AppendContext)
	}
	return SessionStartOutcome{AppendContext: acc}, nil
}

// RunSessionEnd runs the SessionEnd chain, accumulating AppendContext.
func (r *Registry) RunSessionEnd(ctx context.Context, in SessionEndInput) (SessionEndOutcome, error) {
	var acc string
	for _, h := range r.sessionEnd {
		out, err := h.sessionEnd(ctx, in)
		if err != nil {
			return SessionEndOutcome{}, err
		}
		acc = joinContext(acc, out.AppendContext)
	}
	return SessionEndOutcome{AppendContext: acc}, nil
}

// RunPreCompact runs the PreCompact chain, accumulating AppendContext.
func (r *Registry) RunPreCompact(ctx context.Context, in PreCompactInput) (PreCompactOutcome, error) {
	var acc string
	for _, h := range r.preCompact {
		out, err := h.preCompact(ctx, in)
		if err != nil {
			return PreCompactOutcome{}, err
		}
		acc = joinContext(acc, out.AppendContext)
	}
	return PreCompactOutcome{AppendContext: acc}, nil
}

// RunPostCompact runs the PostCompact chain, accumulating AppendContext.
func (r *Registry) RunPostCompact(ctx context.Context, in PostCompactInput) (PostCompactOutcome, error) {
	var acc string
	for _, h := range r.postCompact {
		out, err := h.postCompact(ctx, in)
		if err != nil {
			return PostCompactOutcome{}, err
		}
		acc = joinContext(acc, out.AppendContext)
	}
	return PostCompactOutcome{AppendContext: acc}, nil
}
