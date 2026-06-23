package main

import (
	"context"
	"fmt"
	"os"

	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/mcp"
	"github.com/wickedev/carrier/internal/perm"
	"github.com/wickedev/carrier/internal/plugin"
	"github.com/wickedev/carrier/internal/plugin/wasm"
	"github.com/wickedev/carrier/internal/server"
	"github.com/wickedev/carrier/internal/skill"
	"github.com/wickedev/carrier/internal/subagent"
	"github.com/wickedev/carrier/internal/tool"
)

// newSession builds a per-session Flight from the runtime's shared dependencies
// plus the session's own configuration (opts): an AGENTS.md-like context, a
// model/effort override, env/secrets, permission rules, in-memory skills, named
// sub-agents, and stdio MCP servers. It returns the Flight and a cleanup func
// that runs SessionEnd hooks and closes any MCP subprocesses when the session
// ends. Every session gets its OWN tool registry so per-session skills, named
// sub-agents, and MCP tools never leak across sessions.
func (rt *runtime) newSession(sessionID string, opts server.SessionOptions) (*flight.Flight, func()) {
	reg := tool.NewRegistry()
	reg.Register(tool.NewBash())

	// In-memory skills → a per-session skill gateway. Bodies are captured by a
	// closure (no filesystem), matching skill.Skill's lazy-body contract.
	if len(opts.Skills) > 0 {
		skills := make([]skill.Skill, 0, len(opts.Skills))
		for _, s := range opts.Skills {
			body := s.Body // capture per iteration
			skills = append(skills, skill.Skill{
				Name:             s.Name,
				Description:      s.Description,
				Body:             func() (string, error) { return body, nil },
				AgentRestriction: s.Agent,
				AllowedTools:     s.AllowedTools,
			})
		}
		reg.Register(skill.NewGateway(skills, ""))
	}

	// Per-session executor: working-copy cwd + env/secrets layered onto the host
	// environment for every command the session runs.
	exec := rt.baseExec
	if opts.Cwd != "" {
		exec.Cwd = opts.Cwd
	}
	if len(opts.Env) > 0 {
		exec.Env = envSlice(opts.Env)
	}

	// Permission policy from the session's rules (nil → permissive default).
	var policy perm.Policy
	if len(opts.Permissions) > 0 {
		rules := make([]perm.Rule, 0, len(opts.Permissions))
		for _, p := range opts.Permissions {
			rules = append(rules, perm.Rule{
				Action:  p.Action,
				Pattern: p.Pattern,
				Effect:  parseEffect(p.Effect),
				Source:  perm.SourceProject,
			})
		}
		policy = perm.NewRuleSet(rules...)
	}

	// Named sub-agents → a per-session spawner + task tool that can dispatch to
	// them by name.
	agents := make([]subagent.Agent, 0, len(opts.Subagents))
	for _, a := range opts.Subagents {
		agents = append(agents, subagent.Agent{
			Name:        a.Name,
			Description: a.Description,
			System:      a.Prompt,
			Model:       a.Model,
		})
	}
	spawner := subagent.New(subagent.SpawnerConfig{
		Engine:        rt.engine,
		Store:         rt.store,
		Tools:         reg,
		Exec:          exec,
		Policy:        policy,
		MaxConcurrent: 8,
		MaxDepth:      3,
		Agents:        agents,
	})
	reg.Register(subagent.NewTaskTool(spawner))

	// MCP (stdio) servers: spawn + initialize + register each server's tools.
	// Best-effort — a server that fails to start is logged and skipped rather
	// than failing session creation. Each live client is closed on cleanup.
	var closers []func()
	for _, m := range opts.MCPServers {
		if m.Command == "" {
			continue
		}
		tr, err := mcp.NewStdioTransport(context.Background(), mcp.StdioConfig{
			Command: m.Command,
			Args:    m.Args,
			Env:     envSlice(m.Env),
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "carrier: mcp %q start: %v\n", m.Name, err)
			continue
		}
		client := mcp.NewClient(tr, mcp.ClientConfig{})
		if _, err := client.Initialize(context.Background()); err != nil {
			fmt.Fprintf(os.Stderr, "carrier: mcp %q init: %v\n", m.Name, err)
			_ = client.Close()
			continue
		}
		if err := mcp.RegisterInto(reg, m.Name, client); err != nil {
			fmt.Fprintf(os.Stderr, "carrier: mcp %q register: %v\n", m.Name, err)
			_ = client.Close()
			continue
		}
		c := client
		closers = append(closers, func() { _ = c.Close() })
	}

	// Context (AGENTS.md-like) replaces the default durable memory when present.
	mem := rt.defaultMemory
	if opts.Context != "" {
		mem = opts.Context
	}
	system := rt.defaultSystem
	if opts.System != "" {
		system = opts.System
	}
	budget := rt.defaultBudget
	if opts.ContextBudget > 0 {
		budget = opts.ContextBudget
	}

	// Active (WASM) plugins: resolve by digest, instantiate sandboxed, and build
	// the per-session seam Chain. Best-effort — a plugin that fails to load is
	// skipped. The instances are closed by the cleanup func on session end.
	var pluginChain *plugin.Chain
	if rt.pluginLoader != nil && len(opts.Plugins) > 0 {
		refs := make([]wasm.Ref, 0, len(opts.Plugins))
		for _, p := range opts.Plugins {
			refs = append(refs, wasm.Ref{
				Name: p.Name, Version: p.Version, ManifestDigest: p.ManifestDigest,
				WasmDigest: p.WasmDigest, GrantedCaps: p.GrantedCaps,
				AllowPermissions: p.AllowPermissions,
			})
		}
		chain, closePlugins, _ := rt.pluginLoader.LoadChain(context.Background(), refs, opts.Env)
		// Audit plugin seam failures (Req 7.4): a misbehaving plugin is fail-closed
		// and observable, never silent.
		chain.OnError(func(name string, kind plugin.SeamKind, err error) {
			fmt.Fprintf(os.Stderr, "carrier: plugin %s seam %s failed: %v\n", name, kind, err)
		})
		pluginChain = chain
		closers = append(closers, closePlugins)
	}

	f := flight.New(flight.Config{
		ID:            sessionID,
		System:        system,
		Memory:        mem,
		Model:         opts.Model,
		Effort:        opts.Effort,
		Plugins:       pluginChain,
		Engine:        rt.engine,
		Store:         rt.store,
		Tools:         reg,
		Policy:        policy,
		Exec:          exec,
		Summarizer:    rt.summarizer,
		MaxSteps:      opts.MaxSteps,
		ContextBudget: budget,
		PlanMode:      opts.PlanMode,
	})

	// Lifecycle command hooks: SessionStart runs now; SessionEnd runs on cleanup.
	// (Pre/PostToolUse command hooks are accepted but not yet woven into the
	// Flight's tool-dispatch loop — see docs; that is the next runtime step.)
	runHooks(context.Background(), exec, opts.Hooks, "SessionStart")

	cleanup := func() {
		runHooks(context.Background(), exec, opts.Hooks, "SessionEnd")
		for _, c := range closers {
			c()
		}
	}
	return f, cleanup
}

// envSlice converts a map of env vars into the "KEY=VALUE" slice form the
// executor and MCP transports layer onto the host environment.
func envSlice(m map[string]string) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

// parseEffect maps a wire effect string to a perm.Effect (default Ask).
func parseEffect(s string) perm.Effect {
	switch s {
	case "allow":
		return perm.Allow
	case "deny":
		return perm.Deny
	default:
		return perm.Ask
	}
}

// runHooks runs every command hook bound to the given lifecycle event through
// the session's executor (best-effort; failures are logged, not fatal).
func runHooks(ctx context.Context, exec tool.ExecContext, hooks []server.HookSpec, event string) {
	if exec.Executor == nil {
		return
	}
	for _, h := range hooks {
		if h.Event != event || h.Command == "" {
			continue
		}
		bash := tool.NewBash()
		_, err := bash.Exec(ctx, map[string]any{"command": h.Command}, exec)
		if err != nil {
			fmt.Fprintf(os.Stderr, "carrier: hook %q (%s): %v\n", h.Name, event, err)
		}
	}
}
