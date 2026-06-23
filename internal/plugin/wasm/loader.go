package wasm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wickedev/carrier/internal/plugin"
)

// Ref identifies an active plugin a session should load.
type Ref struct {
	Name           string
	Version        string
	ManifestDigest string
	WasmDigest     string // "sha256-<hex>"
	GrantedCaps    []string
	// AllowPermissions reflects the operator's permission opt-in.
	AllowPermissions bool
}

// Resolver returns the WASM bytes for a ref. Implementations MUST verify the
// bytes against ref.WasmDigest before returning them.
type Resolver interface {
	Resolve(ctx context.Context, ref Ref) ([]byte, error)
}

// CASResolver resolves WASM from a local content-addressed store: a directory of
// files named by their wasm digest. It verifies the digest on read, so a tampered
// or wrong artifact is refused (Req 4.3 / 6.2).
type CASResolver struct{ Dir string }

func (r CASResolver) Resolve(_ context.Context, ref Ref) ([]byte, error) {
	if ref.WasmDigest == "" {
		return nil, fmt.Errorf("plugin %s: empty wasm digest", ref.Name)
	}
	path := filepath.Join(r.Dir, strings.ReplaceAll(ref.WasmDigest, ":", "-"))
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("plugin %s: read artifact: %w", ref.Name, err)
	}
	if got := Digest(b); got != ref.WasmDigest {
		return nil, fmt.Errorf("plugin %s: wasm digest mismatch (want %s, got %s)", ref.Name, ref.WasmDigest, got)
	}
	return b, nil
}

// Digest returns the canonical "sha256-<hex>" digest of b.
func Digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256-" + hex.EncodeToString(sum[:])
}

// Loader builds a per-session plugin.Chain from active plugin refs, resolving and
// compiling (cached by wasm digest) each module and instantiating it sandboxed.
type Loader struct {
	host     *Host
	resolver Resolver

	mu       sync.Mutex
	compiled map[string]*Module // wasm digest → compiled module
}

// NewLoader builds a Loader over a Host and Resolver.
func NewLoader(host *Host, resolver Resolver) *Loader {
	return &Loader{host: host, resolver: resolver, compiled: map[string]*Module{}}
}

// LoadChain resolves, compiles, and instantiates each ref, returning a Chain and
// a cleanup that closes every instance. env supplies secret values: a granted
// "secret:<key>" capability resolves <key> from env. A ref that fails to load is
// skipped (best-effort), so one bad plugin never blocks the session.
func (l *Loader) LoadChain(ctx context.Context, refs []Ref, env map[string]string) (*plugin.Chain, func(), error) {
	var (
		entries []plugin.Entry
		closers []func()
	)
	cleanup := func() {
		for _, c := range closers {
			c()
		}
	}
	for _, ref := range refs {
		mod, err := l.module(ctx, ref)
		if err != nil {
			continue // best-effort; resolution failures are logged by the caller
		}
		inst, err := mod.Instance(ctx, grantFor(ref, env))
		if err != nil {
			continue
		}
		i := inst
		closers = append(closers, func() { _ = i.Close(ctx) })
		entries = append(entries, plugin.Entry{
			Seam:             NewSeam(inst),
			AllowPermissions: ref.AllowPermissions,
		})
	}
	return plugin.NewChain(entries...), cleanup, nil
}

func (l *Loader) module(ctx context.Context, ref Ref) (*Module, error) {
	l.mu.Lock()
	if m, ok := l.compiled[ref.WasmDigest]; ok {
		l.mu.Unlock()
		return m, nil
	}
	l.mu.Unlock()

	wasm, err := l.resolver.Resolve(ctx, ref)
	if err != nil {
		return nil, err
	}
	m, err := l.host.Compile(ctx, ref.Name+"@"+ref.Version, wasm)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	l.compiled[ref.WasmDigest] = m
	l.mu.Unlock()
	return m, nil
}

// grantFor builds a CapabilityGrant from a ref's granted capability tokens and
// the session env. Tokens: "secret:<key>", "network:<host>", "kv".
func grantFor(ref Ref, env map[string]string) CapabilityGrant {
	g := CapabilityGrant{}
	for _, capTok := range ref.GrantedCaps {
		switch {
		case capTok == "kv":
			if g.KV == nil {
				g.KV = newMemKV()
			}
		case strings.HasPrefix(capTok, "secret:"):
			key := strings.TrimPrefix(capTok, "secret:")
			if v, ok := env[key]; ok {
				if g.Secrets == nil {
					g.Secrets = map[string]string{}
				}
				g.Secrets[key] = v
			}
		case strings.HasPrefix(capTok, "network:"):
			g.Network = append(g.Network, strings.TrimPrefix(capTok, "network:"))
		}
	}
	return g
}

// memKV is a per-instance in-memory KV namespace (a durable backing store can be
// substituted later).
type memKV struct {
	mu sync.Mutex
	m  map[string]string
}

func newMemKV() *memKV { return &memKV{m: map[string]string{}} }

func (k *memKV) Get(key string) (string, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	v, ok := k.m[key]
	return v, ok
}
func (k *memKV) Set(key, val string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.m[key] = val
	return nil
}
