package wasm

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/plugin"
)

func TestCASResolverVerifiesDigest(t *testing.T) {
	dir := t.TempDir()
	wasm := buildGuest(t)
	digest := Digest(wasm)
	path := filepath.Join(dir, strings.ReplaceAll(digest, ":", "-"))
	if err := os.WriteFile(path, wasm, 0o600); err != nil {
		t.Fatal(err)
	}
	r := CASResolver{Dir: dir}

	// Correct digest resolves.
	if _, err := r.Resolve(context.Background(), Ref{Name: "x", WasmDigest: digest}); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// A wrong digest (artifact tampered / mismatched) is refused.
	if _, err := r.Resolve(context.Background(), Ref{Name: "x", WasmDigest: "sha256-deadbeef"}); err == nil {
		t.Fatal("expected digest-mismatch refusal")
	}
}

func TestLoaderBuildsChainFromRefs(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	wasm := buildGuest(t)
	digest := Digest(wasm)
	if err := os.WriteFile(filepath.Join(dir, strings.ReplaceAll(digest, ":", "-")), wasm, 0o600); err != nil {
		t.Fatal(err)
	}
	host, err := NewHost(ctx, Limits{})
	if err != nil {
		t.Fatalf("host: %v", err)
	}
	defer host.Close(ctx)
	loader := NewLoader(host, CASResolver{Dir: dir})

	chain, cleanup, err := loader.LoadChain(ctx, []Ref{{
		Name: "ref", Version: "1", WasmDigest: digest,
		GrantedCaps: []string{"secret:API_TOKEN"},
	}}, map[string]string{"API_TOKEN": "tok"})
	if err != nil {
		t.Fatalf("LoadChain: %v", err)
	}
	defer cleanup()

	// The loaded plugin denies "rm" and reads the granted secret for other tools.
	gate := chain.ToolBefore(ctx, "s", agent.ToolCall{ID: "1", Name: "rm"})
	if gate.Effect != plugin.DecisionDeny {
		t.Fatalf("expected deny from loaded plugin, got %v", gate.Effect)
	}
	gate = chain.ToolBefore(ctx, "s", agent.ToolCall{ID: "2", Name: "bash"})
	if gate.ContextAppend != "token=tok" {
		t.Fatalf("granted secret not threaded by loaded plugin: %q", gate.ContextAppend)
	}
}
