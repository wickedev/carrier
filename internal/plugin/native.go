package plugin

import "context"

// Native is a first-party Seam built from Go closures — the zero-sandbox backend
// for trusted, compiled-in extensions. Only the set hooks are advertised via
// Supports; unset hooks abstain (inherited from Base). It implements the same
// Seam interface as the WASM backend, so the Flight loop is backend-agnostic.
type Native struct {
	Base
	OnBeforeStep    func(context.Context, BeforeStepInput) (BeforeStepPatch, error)
	OnToolBefore    func(context.Context, ToolBeforeInput) (ToolBeforeDecision, error)
	OnToolAfter     func(context.Context, ToolAfterInput) (ToolAfterPatch, error)
	OnPermissionAsk func(context.Context, PermissionInput) (PermissionDecision, error)
	OnSessionStart  func(context.Context, LifecycleInput) (LifecyclePatch, error)
	OnSessionEnd    func(context.Context, LifecycleInput) (LifecyclePatch, error)
}

// NewNative builds a Native seam named name. Set the hook fields you implement.
func NewNative(name string) *Native { return &Native{Base: Base{PluginName: name}} }

func (n *Native) Supports(k SeamKind) bool {
	switch k {
	case SeamBeforeStep:
		return n.OnBeforeStep != nil
	case SeamToolBefore:
		return n.OnToolBefore != nil
	case SeamToolAfter:
		return n.OnToolAfter != nil
	case SeamPermissionAsk:
		return n.OnPermissionAsk != nil
	case SeamSessionStart:
		return n.OnSessionStart != nil
	case SeamSessionEnd:
		return n.OnSessionEnd != nil
	}
	return false
}

func (n *Native) BeforeStep(ctx context.Context, in BeforeStepInput) (BeforeStepPatch, error) {
	if n.OnBeforeStep == nil {
		return BeforeStepPatch{}, nil
	}
	return n.OnBeforeStep(ctx, in)
}
func (n *Native) ToolBefore(ctx context.Context, in ToolBeforeInput) (ToolBeforeDecision, error) {
	if n.OnToolBefore == nil {
		return ToolBeforeDecision{Decision: DecisionAbstain}, nil
	}
	return n.OnToolBefore(ctx, in)
}
func (n *Native) ToolAfter(ctx context.Context, in ToolAfterInput) (ToolAfterPatch, error) {
	if n.OnToolAfter == nil {
		return ToolAfterPatch{}, nil
	}
	return n.OnToolAfter(ctx, in)
}
func (n *Native) PermissionAsk(ctx context.Context, in PermissionInput) (PermissionDecision, error) {
	if n.OnPermissionAsk == nil {
		return PermissionDecision{Decision: DecisionAbstain}, nil
	}
	return n.OnPermissionAsk(ctx, in)
}
func (n *Native) SessionStart(ctx context.Context, in LifecycleInput) (LifecyclePatch, error) {
	if n.OnSessionStart == nil {
		return LifecyclePatch{}, nil
	}
	return n.OnSessionStart(ctx, in)
}
func (n *Native) SessionEnd(ctx context.Context, in LifecycleInput) (LifecyclePatch, error) {
	if n.OnSessionEnd == nil {
		return LifecyclePatch{}, nil
	}
	return n.OnSessionEnd(ctx, in)
}
