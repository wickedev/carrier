package plugin

import (
	"context"
	"testing"

	"github.com/wickedev/carrier/internal/agent"
)

func TestNativeSeamSupportsOnlySetHooks(t *testing.T) {
	n := NewNative("first-party")
	n.OnBeforeStep = func(_ context.Context, _ BeforeStepInput) (BeforeStepPatch, error) {
		return BeforeStepPatch{SystemAppend: "native rule"}, nil
	}
	if !n.Supports(SeamBeforeStep) || n.Supports(SeamToolBefore) {
		t.Fatal("Supports should reflect only the set hooks")
	}
	in := &agent.StepInput{System: "base"}
	NewChain(Entry{Seam: n}).BeforeStep(context.Background(), "s", in)
	if in.System != "base\n\nnative rule" {
		t.Fatalf("native before_step not applied: %q", in.System)
	}
}
