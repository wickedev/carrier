package wasm

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/plugin"
)

// buildGuest compiles the reference guest to wasm, skipping if the wasip1
// toolchain is unavailable.
func buildGuest(t *testing.T) []byte {
	t.Helper()
	out := filepath.Join(t.TempDir(), "guest.wasm")
	cmd := exec.Command("go", "build", "-buildmode=c-shared", "-o", out, ".")
	cmd.Dir = "testdata/guest"
	cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("cannot build wasip1 guest (need Go wasm toolchain): %v\n%s", err, b)
	}
	wasm, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read guest wasm: %v", err)
	}
	return wasm
}

type mapKV map[string]string

func (m mapKV) Get(k string) (string, bool) { v, ok := m[k]; return v, ok }
func (m mapKV) Set(k, v string) error       { m[k] = v; return nil }

func newSeam(t *testing.T, grant CapabilityGrant) (*Seam, func()) {
	t.Helper()
	ctx := context.Background()
	host, err := NewHost(ctx, Limits{CallTimeout: time.Second})
	if err != nil {
		t.Fatalf("NewHost: %v", err)
	}
	mod, err := host.Compile(ctx, "ref@1", buildGuest(t))
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	inst, err := mod.Instance(ctx, grant)
	if err != nil {
		t.Fatalf("Instance: %v", err)
	}
	return NewSeam(inst), func() { _ = inst.Close(ctx); _ = host.Close(ctx) }
}

func TestWasmBeforeStepAndSupports(t *testing.T) {
	s, done := newSeam(t, CapabilityGrant{})
	defer done()
	if !s.Supports(plugin.SeamBeforeStep) || !s.Supports(plugin.SeamToolBefore) {
		t.Fatal("expected before_step + tool_before support")
	}
	if s.Supports(plugin.SeamSessionEnd) {
		t.Fatal("session_end is not exported by the guest")
	}
	patch, err := s.BeforeStep(context.Background(), plugin.BeforeStepInput{System: "base"})
	if err != nil {
		t.Fatalf("BeforeStep: %v", err)
	}
	if patch.SystemAppend != "added by plugin" {
		t.Fatalf("patch = %+v", patch)
	}
}

func TestWasmToolBeforeDeny(t *testing.T) {
	s, done := newSeam(t, CapabilityGrant{})
	defer done()
	d, err := s.ToolBefore(context.Background(), plugin.ToolBeforeInput{Tool: "rm"})
	if err != nil {
		t.Fatalf("ToolBefore: %v", err)
	}
	if d.Decision != plugin.DecisionDeny {
		t.Fatalf("expected deny, got %+v", d)
	}
}

func TestWasmSecretCapabilityGating(t *testing.T) {
	// Without the secret granted, the guest sees no token → plain allow.
	s1, done1 := newSeam(t, CapabilityGrant{})
	defer done1()
	d, err := s1.ToolBefore(context.Background(), plugin.ToolBeforeInput{Tool: "bash"})
	if err != nil {
		t.Fatalf("ToolBefore: %v", err)
	}
	if d.ContextAppend != "" {
		t.Fatalf("ungranted secret leaked: %q", d.ContextAppend)
	}

	// With the secret granted, the guest reads it via secret_get.
	s2, done2 := newSeam(t, CapabilityGrant{Secrets: map[string]string{"API_TOKEN": "s3cr3t"}})
	defer done2()
	d, err = s2.ToolBefore(context.Background(), plugin.ToolBeforeInput{Tool: "bash"})
	if err != nil {
		t.Fatalf("ToolBefore: %v", err)
	}
	if d.ContextAppend != "token=s3cr3t" {
		t.Fatalf("granted secret not returned: %q", d.ContextAppend)
	}
}

func TestWasmDeadlineInterrupts(t *testing.T) {
	ctx := context.Background()
	host, err := NewHost(ctx, Limits{CallTimeout: 150 * time.Millisecond})
	if err != nil {
		t.Fatalf("NewHost: %v", err)
	}
	defer host.Close(ctx)
	mod, err := host.Compile(ctx, "ref@1", buildGuest(t))
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	inst, err := mod.Instance(ctx, CapabilityGrant{})
	if err != nil {
		t.Fatalf("Instance: %v", err)
	}
	defer inst.Close(ctx)
	s := NewSeam(inst)

	start := time.Now()
	_, err = s.BeforeStep(ctx, plugin.BeforeStepInput{System: "SPIN"})
	if err == nil {
		t.Fatal("expected the spinning guest to be interrupted by the deadline")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("deadline did not interrupt promptly: %v", elapsed)
	}
}

func TestWasmTrapContained(t *testing.T) {
	s, done := newSeam(t, CapabilityGrant{})
	defer done()
	// A guest panic surfaces as an error, not a host crash.
	if _, err := s.BeforeStep(context.Background(), plugin.BeforeStepInput{System: "PANIC"}); err == nil {
		t.Fatal("expected a trap error from the panicking guest")
	}
	// The host is still usable for other instances afterward (no global damage).
	s2, done2 := newSeam(t, CapabilityGrant{})
	defer done2()
	if _, err := s2.BeforeStep(context.Background(), plugin.BeforeStepInput{System: "ok"}); err != nil {
		t.Fatalf("host unusable after trap: %v", err)
	}
}
