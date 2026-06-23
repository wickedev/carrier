package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tower"
)

// TestCreateParsesSessionOptions verifies the POST /v1/sessions body is decoded
// into SessionOptions and handed to the Factory verbatim (the per-session config
// plumbing the BFF relies on), and that an empty body still yields a session.
func TestCreateParsesSessionOptions(t *testing.T) {
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	captured := make(chan SessionOptions, 4)
	factory := func(sid, tenant string, opts SessionOptions) (*flight.Flight, func()) {
		captured <- opts
		f := flight.New(flight.Config{
			ID:     sid,
			System: "test",
			Engine: fakeEngine{reply: "ok"},
			Store:  st,
		})
		return f, nil
	}

	tw := tower.New(8)
	srv := New(tw, factory, st, map[string]string{"tok": "default"})
	t.Cleanup(srv.Shutdown)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	body := map[string]any{
		"cwd":            "/work/wc",
		"context":        "Be terse.",
		"model":          "claude-test",
		"plan_mode":      true,
		"max_steps":      7,
		"context_budget": 1234,
		"env":            map[string]string{"TOKEN": "secret"},
		"mcp_servers": []map[string]any{
			{"name": "fs", "command": "mcp-fs", "args": []string{"--root", "/"}, "env": map[string]string{"K": "V"}},
		},
		"skills": []map[string]any{
			{"name": "lint", "description": "lint code", "body": "do lint", "allowed_tools": []string{"bash"}},
		},
		"subagents": []map[string]any{
			{"name": "writer", "description": "writes", "prompt": "You write.", "model": "m2"},
		},
		"hooks": []map[string]any{
			{"name": "greet", "event": "SessionStart", "command": "echo hi"},
		},
		"permissions": []map[string]any{
			{"action": "bash", "pattern": "rm *", "effect": "deny"},
		},
	}
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/sessions", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, want 200", resp.StatusCode)
	}

	opts := <-captured
	if opts.Cwd != "/work/wc" || opts.Context != "Be terse." || opts.Model != "claude-test" {
		t.Fatalf("scalars not parsed: %+v", opts)
	}
	if !opts.PlanMode || opts.MaxSteps != 7 || opts.ContextBudget != 1234 {
		t.Fatalf("flags not parsed: %+v", opts)
	}
	if opts.Env["TOKEN"] != "secret" {
		t.Fatalf("env not parsed: %+v", opts.Env)
	}
	if len(opts.MCPServers) != 1 || opts.MCPServers[0].Command != "mcp-fs" || opts.MCPServers[0].Env["K"] != "V" {
		t.Fatalf("mcp not parsed: %+v", opts.MCPServers)
	}
	if len(opts.Skills) != 1 || opts.Skills[0].Name != "lint" || opts.Skills[0].Body != "do lint" {
		t.Fatalf("skills not parsed: %+v", opts.Skills)
	}
	if len(opts.Subagents) != 1 || opts.Subagents[0].Prompt != "You write." || opts.Subagents[0].Model != "m2" {
		t.Fatalf("subagents not parsed: %+v", opts.Subagents)
	}
	if len(opts.Hooks) != 1 || opts.Hooks[0].Event != "SessionStart" || opts.Hooks[0].Command != "echo hi" {
		t.Fatalf("hooks not parsed: %+v", opts.Hooks)
	}
	if len(opts.Permissions) != 1 || opts.Permissions[0].Effect != "deny" {
		t.Fatalf("permissions not parsed: %+v", opts.Permissions)
	}

	// An empty body must still create a session (zero options).
	req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/sessions", nil)
	req2.Header.Set("Authorization", "Bearer tok")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("create empty: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("empty-body create status = %d, want 200", resp2.StatusCode)
	}
	empty := <-captured
	if empty.Cwd != "" || len(empty.MCPServers) != 0 {
		t.Fatalf("empty body should yield zero options, got %+v", empty)
	}
}
