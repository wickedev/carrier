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
	defaultSystem string
	defaultMemory string
	defaultBudget int
}

// buildRuntime assembles the shared Store, Engine, Executor, and durable Memory.
func buildRuntime() (*runtime, error) {
	st, err := store.NewFileStore(filepath.Join(os.TempDir(), "carrier", "sessions"))
	if err != nil {
		return nil, err
	}

	// Throttled engine to protect the provider from 429 storms across sessions.
	eng := engine.NewThrottle(engine.NewAnthropicEngine(), 8, 4)

	cwd, _ := os.Getwd()
	mem, _ := memory.LoadInstructions(cwd, 0)

	return &runtime{
		store:         st,
		engine:        eng,
		baseExec:      tool.ExecContext{Executor: bay.NewLocalExecutor()},
		summarizer:    flight.EngineSummarizer{Engine: eng},
		defaultSystem: systemPrompt,
		defaultMemory: mem,
		defaultBudget: 150000,
	}, nil
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
		ContextBudget: rt.defaultBudget,
	}
}

func serve() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

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

	addr := os.Getenv("CARRIER_ADDR")
	if addr == "" {
		addr = ":8080"
	}
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
