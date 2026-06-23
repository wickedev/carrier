// Package wasm is the sandboxed (wazero) backend for Carrier plugins. A plugin's
// WebAssembly module runs with zero ambient authority: it can only reach the host
// through the explicit capability imports in the "carrier" host module, each
// gated by the per-session CapabilityGrant. Seam calls run under a wall-clock
// deadline and a memory limit; a trap or timeout is contained (the instance is
// closed) rather than crashing the session.
//
// ABI (carrier.plugin/v1, guest side):
//   - exports linear "memory"
//   - export plugin_buffer() i32      → address of a fixed I/O buffer
//   - export plugin_buffer_size() i32 → its capacity
//   - export <seam>(in_len i32) i32   → reads in_len JSON bytes from the buffer,
//     writes JSON result to the buffer, returns out_len (>=0) or -1 on error.
//   - imports (module "carrier"): log, secret_get, kv_get, kv_set (capability-gated)
package wasm

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// Limits bound a single seam invocation and an instance's memory.
type Limits struct {
	CallTimeout time.Duration // per-seam wall-clock deadline (0 → 2s)
	MemoryPages uint32        // max linear-memory pages, 64KiB each (0 → 256 = 16MiB)
}

func (l Limits) timeout() time.Duration {
	if l.CallTimeout <= 0 {
		return 2 * time.Second
	}
	return l.CallTimeout
}

// CapabilityGrant is the authority an instance was granted at install time. The
// host functions consult it; anything not granted is denied.
type CapabilityGrant struct {
	Secrets map[string]string // declared & resolved secret values
	KV      KVStore           // namespaced store, nil → kv denied
	Network []string          // allowed http_fetch hosts (unused stub for now)
}

// KVStore is a namespaced key/value store handed to a plugin instance.
type KVStore interface {
	Get(key string) (string, bool)
	Set(key, val string) error
}

// Host owns the wazero runtime (with a compilation cache) shared across plugins.
type Host struct {
	rt      wazero.Runtime
	limits  Limits
	logSink func(msg string)
}

// NewHost builds a Host. The runtime closes instances when their call context is
// done (enabling deadline interruption) and caps linear memory per the limits.
func NewHost(ctx context.Context, limits Limits) (*Host, error) {
	pages := limits.MemoryPages
	if pages == 0 {
		pages = 256
	}
	cfg := wazero.NewRuntimeConfig().
		WithCloseOnContextDone(true).
		WithMemoryLimitPages(pages)
	rt := wazero.NewRuntimeWithConfig(ctx, cfg)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("wasm: wasi: %w", err)
	}
	h := &Host{rt: rt, limits: limits}
	if err := h.registerCarrierModule(ctx); err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	return h, nil
}

// Close tears down the runtime and every instance.
func (h *Host) Close(ctx context.Context) error { return h.rt.Close(ctx) }

// Module is a compiled-once plugin artifact.
type Module struct {
	host     *Host
	compiled wazero.CompiledModule
	name     string
}

// Compile compiles a WASM module once; instantiate per session via Instance.
func (h *Host) Compile(ctx context.Context, name string, wasm []byte) (*Module, error) {
	cm, err := h.rt.CompileModule(ctx, wasm)
	if err != nil {
		return nil, fmt.Errorf("wasm: compile %s: %w", name, err)
	}
	return &Module{host: h, compiled: cm, name: name}, nil
}

// Instance is a per-session, isolated instantiation of a Module.
type Instance struct {
	mod     api.Module
	host    *Host
	grant   CapabilityGrant
	bufPtr  uint32
	bufSize uint32
	name    string
}

// Instance instantiates the module with its own linear memory and the given
// capability grant. The grant is consulted by the host functions during calls.
func (m *Module) Instance(ctx context.Context, grant CapabilityGrant) (*Instance, error) {
	// Go wasip1 c-shared builds are WASI "reactor" modules: run _initialize
	// (Go runtime + package init) at instantiation, not the command _start.
	mod, err := m.host.rt.InstantiateModule(ctx, m.compiled,
		wazero.NewModuleConfig().WithName("").WithStartFunctions("_initialize"))
	if err != nil {
		return nil, fmt.Errorf("wasm: instantiate %s: %w", m.name, err)
	}
	inst := &Instance{mod: mod, host: m.host, grant: grant, name: m.name}

	bufFn := mod.ExportedFunction("plugin_buffer")
	sizeFn := mod.ExportedFunction("plugin_buffer_size")
	if bufFn == nil || sizeFn == nil {
		_ = mod.Close(ctx)
		return nil, errors.New("wasm: guest missing plugin_buffer/plugin_buffer_size")
	}
	bp, err := bufFn.Call(ctx)
	if err != nil {
		_ = mod.Close(ctx)
		return nil, fmt.Errorf("wasm: plugin_buffer: %w", err)
	}
	bs, err := sizeFn.Call(ctx)
	if err != nil {
		_ = mod.Close(ctx)
		return nil, fmt.Errorf("wasm: plugin_buffer_size: %w", err)
	}
	inst.bufPtr, inst.bufSize = uint32(bp[0]), uint32(bs[0])
	return inst, nil
}

// Supports reports whether the guest exports the given seam entry point.
func (i *Instance) Supports(seam string) bool {
	return i.mod.ExportedFunction(seam) != nil
}

// Close releases the instance.
func (i *Instance) Close(ctx context.Context) error { return i.mod.Close(ctx) }

var errTooBig = errors.New("wasm: payload exceeds guest buffer")

// Invoke writes inJSON into the guest buffer, calls the seam under a deadline,
// and returns the guest's JSON output. The grant is attached to the call context
// so the capability host functions can enforce it.
func (i *Instance) Invoke(ctx context.Context, seam string, inJSON []byte) ([]byte, error) {
	fn := i.mod.ExportedFunction(seam)
	if fn == nil {
		return nil, fmt.Errorf("wasm: seam %q not exported", seam)
	}
	if uint32(len(inJSON)) > i.bufSize {
		return nil, errTooBig
	}
	if !i.mod.Memory().Write(i.bufPtr, inJSON) {
		return nil, errors.New("wasm: write input failed")
	}

	callCtx, cancel := context.WithTimeout(ctx, i.host.limits.timeout())
	defer cancel()
	callCtx = withCallState(callCtx, &callState{grant: i.grant})

	res, err := fn.Call(callCtx, uint64(len(inJSON)))
	if err != nil {
		// A trap, timeout, or guest panic lands here — contained, never fatal.
		return nil, fmt.Errorf("wasm: %s/%s: %w", i.name, seam, err)
	}
	outLen := int32(res[0])
	if outLen < 0 {
		return nil, fmt.Errorf("wasm: %s/%s returned error", i.name, seam)
	}
	if uint32(outLen) > i.bufSize {
		return nil, errTooBig
	}
	out, ok := i.mod.Memory().Read(i.bufPtr, uint32(outLen))
	if !ok {
		return nil, errors.New("wasm: read output failed")
	}
	// Copy out of the shared linear memory before returning.
	cp := make([]byte, len(out))
	copy(cp, out)
	return cp, nil
}
