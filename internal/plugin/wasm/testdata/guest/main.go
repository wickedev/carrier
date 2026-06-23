//go:build wasip1

// Command guest is the reference Carrier plugin, compiled to wasm
//
//	GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o guest.wasm .
//
// It implements the carrier.plugin/v1 ABI over a fixed I/O buffer and exercises
// the capability imports (log, secret_get). The host test compiles and drives it.
package main

import (
	"encoding/json"
	"unsafe"
)

func main() {}

// Fixed buffers in linear memory whose addresses are stable for the host.
var (
	ioBuf     [65536]byte
	scratch   [4096]byte
	secretOut [4096]byte
)

func ptr(b *byte) uint32 { return uint32(uintptr(unsafe.Pointer(b))) }

//go:wasmexport plugin_buffer
func pluginBuffer() int32 { return int32(ptr(&ioBuf[0])) }

//go:wasmexport plugin_buffer_size
func pluginBufferSize() int32 { return int32(len(ioBuf)) }

//go:wasmimport carrier log
func hostLog(ptr, length uint32)

//go:wasmimport carrier secret_get
func hostSecretGet(keyPtr, keyLen, outPtr, outMax uint32) int32

func logMsg(s string) {
	n := copy(scratch[:], s)
	hostLog(ptr(&scratch[0]), uint32(n))
}

func getSecret(key string) (string, bool) {
	n := copy(scratch[:], key)
	r := hostSecretGet(ptr(&scratch[0]), uint32(n), ptr(&secretOut[0]), uint32(len(secretOut)))
	if r < 0 {
		return "", false
	}
	return string(secretOut[:r]), true
}

// reply marshals v into the I/O buffer and returns its length.
func reply(v any) int32 {
	out, err := json.Marshal(v)
	if err != nil {
		return -1
	}
	if len(out) > len(ioBuf) {
		return -1
	}
	copy(ioBuf[:], out)
	return int32(len(out))
}

func input(inLen int32, v any) bool {
	return json.Unmarshal(ioBuf[:inLen], v) == nil
}

// ── seams ───────────────────────────────────────────────────────────────────

//go:wasmexport before_step
func beforeStep(inLen int32) int32 {
	var in struct {
		System string `json:"system"`
	}
	if !input(inLen, &in) {
		return -1
	}
	logMsg("before_step from guest")
	switch in.System {
	case "SPIN": // deadline test: never return
		for {
		}
	case "PANIC": // trap test
		panic("guest panic")
	}
	return reply(map[string]any{"system_append": "added by plugin"})
}

//go:wasmexport tool_before
func toolBefore(inLen int32) int32 {
	var in struct {
		Tool  string         `json:"tool"`
		Input map[string]any `json:"input"`
	}
	if !input(inLen, &in) {
		return -1
	}
	if in.Tool == "rm" {
		return reply(map[string]any{"decision": "deny", "reason": "rm forbidden by plugin"})
	}
	// Demonstrate a gated secret read: include it in appended context if allowed.
	if v, ok := getSecret("API_TOKEN"); ok {
		return reply(map[string]any{"decision": "allow", "context_append": "token=" + v})
	}
	return reply(map[string]any{"decision": "allow"})
}

//go:wasmexport permission_ask
func permissionAsk(inLen int32) int32 {
	return reply(map[string]any{"decision": "abstain"})
}
