package wasm

import (
	"context"

	"github.com/tetratelabs/wazero/api"
)

// callState carries the per-invocation capability grant. It is attached to the
// call context by Invoke so the shared host functions can enforce authority
// without per-instance host modules.
type callState struct {
	grant CapabilityGrant
}

type callStateKey struct{}

func withCallState(ctx context.Context, s *callState) context.Context {
	return context.WithValue(ctx, callStateKey{}, s)
}

func callStateFrom(ctx context.Context) *callState {
	s, _ := ctx.Value(callStateKey{}).(*callState)
	return s
}

// LogSink, when set, receives plugin log lines. Default: discard.
func (h *Host) SetLogSink(fn func(msg string)) { h.logSink = fn }

// registerCarrierModule defines the "carrier" host module: the only authority a
// plugin can reach, every function gated by the call's CapabilityGrant.
func (h *Host) registerCarrierModule(ctx context.Context) error {
	b := h.rt.NewHostModuleBuilder("carrier")

	// log(ptr, len): emit a plugin log line. Always permitted (no authority).
	b.NewFunctionBuilder().
		WithFunc(func(ctx context.Context, mod api.Module, ptr, length uint32) {
			if msg, ok := mod.Memory().Read(ptr, length); ok && h.logSink != nil {
				h.logSink(string(msg))
			}
		}).Export("log")

	// secret_get(keyPtr,keyLen,outPtr,outMax) -> len | -1: read a declared secret.
	// Only keys present in the grant's resolved secret map are returned.
	b.NewFunctionBuilder().
		WithFunc(func(ctx context.Context, mod api.Module, keyPtr, keyLen, outPtr, outMax uint32) int32 {
			s := callStateFrom(ctx)
			if s == nil {
				return -1
			}
			key, ok := mod.Memory().Read(keyPtr, keyLen)
			if !ok {
				return -1
			}
			val, granted := s.grant.Secrets[string(key)]
			if !granted {
				return -1
			}
			return writeBounded(mod, outPtr, outMax, val)
		}).Export("secret_get")

	// kv_get(keyPtr,keyLen,outPtr,outMax) -> len | -1.
	b.NewFunctionBuilder().
		WithFunc(func(ctx context.Context, mod api.Module, keyPtr, keyLen, outPtr, outMax uint32) int32 {
			s := callStateFrom(ctx)
			if s == nil || s.grant.KV == nil {
				return -1
			}
			key, ok := mod.Memory().Read(keyPtr, keyLen)
			if !ok {
				return -1
			}
			val, found := s.grant.KV.Get(string(key))
			if !found {
				return -1
			}
			return writeBounded(mod, outPtr, outMax, val)
		}).Export("kv_get")

	// kv_set(keyPtr,keyLen,valPtr,valLen) -> 0 | -1.
	b.NewFunctionBuilder().
		WithFunc(func(ctx context.Context, mod api.Module, keyPtr, keyLen, valPtr, valLen uint32) int32 {
			s := callStateFrom(ctx)
			if s == nil || s.grant.KV == nil {
				return -1
			}
			key, ok := mod.Memory().Read(keyPtr, keyLen)
			if !ok {
				return -1
			}
			val, ok := mod.Memory().Read(valPtr, valLen)
			if !ok {
				return -1
			}
			if err := s.grant.KV.Set(string(key), string(val)); err != nil {
				return -1
			}
			return 0
		}).Export("kv_set")

	if _, err := b.Instantiate(ctx); err != nil {
		return err
	}
	return nil
}

// writeBounded writes val to guest memory at outPtr (truncated to outMax) and
// returns the number of bytes written, or -1 on a memory fault.
func writeBounded(mod api.Module, outPtr, outMax uint32, val string) int32 {
	b := []byte(val)
	if uint32(len(b)) > outMax {
		b = b[:outMax]
	}
	if !mod.Memory().Write(outPtr, b) {
		return -1
	}
	return int32(len(b))
}
