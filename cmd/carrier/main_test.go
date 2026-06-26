package main

import (
	"errors"
	"testing"

	"github.com/wickedev/carrier/internal/engine"
)

func TestIsLoopbackAddr(t *testing.T) {
	loopback := []string{"127.0.0.1:39099", "localhost:8080", "[::1]:8080", "127.0.0.1"}
	for _, a := range loopback {
		if !isLoopbackAddr(a) {
			t.Errorf("isLoopbackAddr(%q) = false, want true", a)
		}
	}
	public := []string{":8080", "0.0.0.0:8080", "[::]:8080", "192.168.1.10:8080", "10.0.0.1:80", ""}
	for _, a := range public {
		if isLoopbackAddr(a) {
			t.Errorf("isLoopbackAddr(%q) = true, want false", a)
		}
	}
}

func TestByosRequestedExplicitOnly(t *testing.T) {
	// Not auto-enabled by a missing API key or a present token — only the explicit
	// CARRIER_AUTH=codex turns it on.
	t.Setenv("CARRIER_AUTH", "")
	if byosRequested() {
		t.Fatal("BYOS must not be enabled without an explicit opt-in")
	}
	t.Setenv("CARRIER_AUTH", "anthropic")
	if byosRequested() {
		t.Fatal("CARRIER_AUTH=anthropic must not enable BYOS")
	}
	t.Setenv("CARRIER_AUTH", "codex")
	if !byosRequested() {
		t.Fatal("CARRIER_AUTH=codex must enable BYOS")
	}
}

func TestSelectEngineDefaultsToAnthropic(t *testing.T) {
	t.Setenv("CARRIER_AUTH", "")
	eng, err := selectEngine()
	if err != nil || eng == nil {
		t.Fatalf("default selection should yield an engine, got eng=%v err=%v", eng, err)
	}
	if eng.Name() != "anthropic" {
		t.Errorf("default engine = %q, want anthropic", eng.Name())
	}
}

func TestSelectEngineExplicitGeminiFailsLoud(t *testing.T) {
	// An explicit CARRIER_AUTH=gemini whose engine cannot construct must FAIL —
	// never silently fall back to a different provider.
	t.Setenv("CARRIER_AUTH", "gemini")
	orig := newGeminiEngine
	t.Cleanup(func() { newGeminiEngine = orig })
	newGeminiEngine = func() (engine.Engine, error) {
		return nil, errors.New("no credentials")
	}

	eng, err := selectEngine()
	if err == nil {
		t.Fatalf("explicit gemini that can't construct must error, got engine %v", eng)
	}
	if eng != nil {
		t.Fatalf("on failure no engine must be returned (no silent fallback), got %v", eng)
	}
}
