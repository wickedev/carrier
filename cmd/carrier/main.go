// Command carrier is the entrypoint for the Carrier agent runtime.
//
// Usage:
//
//	carrier serve     run the HTTP+SSE server (multi-session)
//	carrier           run a one-shot local smoke test
//
// `serve` is the real surface: it wires the Store, Engine (throttled), tool
// Registry (bash + subagent task tool), Executor, durable Memory, and the Tower
// behind the HTTP API. The smoke test launches a single Flight and streams its
// events to stdout.
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/bay"
	"github.com/wickedev/carrier/internal/engine"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/memory"
	"github.com/wickedev/carrier/internal/plugin/wasm"
	"github.com/wickedev/carrier/internal/server"
	"github.com/wickedev/carrier/internal/sq"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/subagent"
	"github.com/wickedev/carrier/internal/tool"
	"github.com/wickedev/carrier/internal/tower"
)

const systemPrompt = "You are a coding agent running inside Carrier."

func main() {
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		if err := serve(); err != nil {
			fmt.Fprintf(os.Stderr, "carrier: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := smokeTest(); err != nil {
		fmt.Fprintf(os.Stderr, "carrier: %v\n", err)
		os.Exit(1)
	}
}

// runtime holds the shared, session-independent dependencies (Store, Engine,
// base Executor, summarizer, defaults). Per-session Flights are built from it by
// newSession (see session.go), which layers each session's config — context,
// model, env, permissions, skills, named sub-agents, and MCP servers — on top.
type runtime struct {
	store         store.Store
	engine        engine.Engine
	baseExec      tool.ExecContext
	summarizer    flight.Summarizer
	titler        flight.Titler
	defaultSystem string
	defaultMemory string
	defaultBudget int
	pluginLoader  *wasm.Loader // nil → plugins disabled
}

// byosRequested reports whether the operator EXPLICITLY opted into the Codex BYOS
// engine. It is deliberately explicit-only (never auto-enabled by the mere
// presence of a token) so a production deployment with no ANTHROPIC_API_KEY can
// never silently serve every tenant off one personal ChatGPT subscription.
func byosRequested() bool { return os.Getenv("CARRIER_AUTH") == "codex" }

// isLoopbackAddr reports whether a listen address binds ONLY the loopback
// interface (so it is unreachable from other hosts). A wildcard host (":8080" /
// "0.0.0.0:..." / "[::]:...") binds all interfaces and is NOT loopback.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr // no port; treat the whole string as the host
	}
	if host == "" {
		return false // ":8080" → all interfaces
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// selectEngine picks the LLM backend.
//
// Default: the Anthropic API engine (production; reads ANTHROPIC_API_KEY).
//
// LOCAL DEV ONLY — Codex BYOS: only when CARRIER_AUTH=codex is explicitly set.
// It authenticates with the developer's ChatGPT SUBSCRIPTION OAuth token (no API
// key), shares that subscription's rate limit, and is a ToS gray area. `serve`
// additionally refuses to start with BYOS unless bound to a loopback address (see
// serve), so it can never serve remote/multi-tenant traffic.
func selectEngine() (engine.Engine, error) {
	if byosRequested() {
		fmt.Fprintln(os.Stderr, "carrier: using Codex BYOS engine (ChatGPT subscription, LOCAL DEV ONLY)")
		return engine.NewCodexEngine(), nil
	}
	if os.Getenv("CARRIER_AUTH") == "gemini" {
		// Native Google Gemini (unified SDK). Backend resolves from the
		// environment: Developer API via GEMINI_API_KEY/GOOGLE_API_KEY, or Vertex
		// AI via GOOGLE_GENAI_USE_VERTEXAI=1 + GOOGLE_CLOUD_PROJECT/_LOCATION.
		// An explicit selection must never silently fall back to a different
		// provider — fail startup if Gemini can't be constructed.
		eng, err := newGeminiEngine()
		if err != nil {
			return nil, fmt.Errorf("CARRIER_AUTH=gemini but the Gemini engine could not start: %w", err)
		}
		fmt.Fprintln(os.Stderr, "carrier: using Gemini engine (google.golang.org/genai)")
		return eng, nil
	}
	return engine.NewAnthropicEngine(), nil
}

// newGeminiEngine constructs the Gemini engine. It is a package var so a test can
// substitute a failing constructor and assert that explicit selection fails
// loudly instead of silently falling back.
var newGeminiEngine = func() (engine.Engine, error) {
	eng, err := engine.NewGeminiEngine()
	if err != nil {
		return nil, err
	}
	return eng, nil
}

// buildRuntime assembles the shared Store, Engine, Executor, and durable Memory.
func buildRuntime() (*runtime, error) {
	st, err := store.NewFileStore(filepath.Join(os.TempDir(), "carrier", "sessions"))
	if err != nil {
		return nil, err
	}

	// Throttled engine to protect the provider from 429 storms across sessions.
	selected, err := selectEngine()
	if err != nil {
		return nil, err
	}
	eng := engine.NewThrottle(selected, 8, 4)

	cwd, _ := os.Getwd()
	mem, _ := memory.LoadInstructions(cwd, 0)

	rt := &runtime{
		store:         st,
		engine:        eng,
		baseExec:      tool.ExecContext{Executor: bay.NewLocalExecutor()},
		summarizer:    flight.EngineSummarizer{Engine: eng},
		titler:        flight.EngineTitler{Engine: eng},
		defaultSystem: systemPrompt,
		defaultMemory: mem,
		defaultBudget: 150000,
	}

	// Plugin host (wazero), enabled when a content-addressed artifact cache dir is
	// configured. Plugins resolve their WASM from it by digest.
	if cacheDir := os.Getenv("CARRIER_PLUGIN_CACHE"); cacheDir != "" {
		host, err := wasm.NewHost(context.Background(), wasm.Limits{})
		if err != nil {
			return nil, err
		}
		host.SetLogSink(func(msg string) { fmt.Fprintf(os.Stderr, "carrier: plugin: %s\n", msg) })
		rt.pluginLoader = wasm.NewLoader(host, wasm.CASResolver{Dir: cacheDir})
	}
	return rt, nil
}

// baseConfig builds a default template flight.Config (no per-session config) with
// a fresh tool registry (bash + a generic sub-agent task tool). Used by the
// one-shot smoke test.
func (rt *runtime) baseConfig() flight.Config {
	reg := tool.NewRegistry()
	reg.Register(tool.NewBash())
	spawner := subagent.New(subagent.SpawnerConfig{
		Engine: rt.engine, Store: rt.store, Tools: reg, Exec: rt.baseExec,
		MaxConcurrent: 8, MaxDepth: 3,
	})
	reg.Register(subagent.NewTaskTool(spawner))
	return flight.Config{
		System:        rt.defaultSystem,
		Memory:        rt.defaultMemory,
		Engine:        rt.engine,
		Store:         rt.store,
		Tools:         reg,
		Exec:          rt.baseExec,
		Summarizer:    rt.summarizer,
		Titler:        rt.titler,
		ContextBudget: rt.defaultBudget,
	}
}

func serve() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	addr := os.Getenv("CARRIER_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	// Safety guard: the Codex BYOS engine (one personal ChatGPT subscription) is
	// for local single-user dev only and must never serve remote/multi-tenant
	// traffic. Refuse to start the multi-session server with BYOS unless it is
	// bound to a loopback address — so it physically cannot be reached by other
	// tenants over the network. Production must use ANTHROPIC_API_KEY (default
	// engine) instead.
	if byosRequested() && !isLoopbackAddr(addr) {
		return fmt.Errorf(
			"refusing to serve with Codex BYOS on non-loopback address %q: "+
				"BYOS (CARRIER_AUTH=codex) is local-dev-only — bind 127.0.0.1, "+
				"or use ANTHROPIC_API_KEY for a real deployment", addr)
	}

	rt, err := buildRuntime()
	if err != nil {
		return err
	}

	tw := tower.New(256)
	factory := func(sessionID, tenant string, opts server.SessionOptions) (*flight.Flight, func()) {
		return rt.newSession(sessionID, opts)
	}

	token := os.Getenv("CARRIER_TOKEN")
	if token == "" {
		token = "dev-token"
	}
	srv := server.New(tw, factory, rt.store, map[string]string{token: "default"})

	httpSrv := &http.Server{Addr: addr, Handler: srv.Handler()}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	fmt.Printf("carrier: serving on %s (bearer token: %s)\n", addr, token)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func smokeTest() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	rt, err := buildRuntime()
	if err != nil {
		return err
	}
	tmpl := rt.baseConfig()
	tmpl.ID = "smoke-1"
	f := flight.New(tmpl)

	tw := tower.New(8)
	fmt.Printf("carrier: launching %s on engine %q\n", f.ID(), tmpl.Engine.Name())
	if err := tw.Launch(ctx, f); err != nil {
		return err
	}
	if err := f.Queues().Submit(ctx, sq.Input{
		Msg:      agent.Message{Role: agent.RoleUser, Text: "Say hello."},
		Delivery: sq.Queue,
	}); err != nil {
		return err
	}

	for ev := range f.Queues().Events() {
		switch ev.Kind {
		case agent.EvText:
			fmt.Print(ev.Text)
		case agent.EvToolCall:
			fmt.Printf("\n[tool-call %s]\n", ev.ToolCall.Name)
		case agent.EvToolResult:
			fmt.Printf("\n[tool-result]\n%s\n", ev.Result.Content)
		case agent.EvError:
			fmt.Fprintf(os.Stderr, "\n[error] %v\n", ev.Err)
		}
	}
	tw.Wait()
	fmt.Println()
	return nil
}
