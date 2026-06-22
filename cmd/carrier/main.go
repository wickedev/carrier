// Command carrier is the entrypoint for the Carrier agent runtime.
//
// This wires the runtime end to end — Store, Engine, tool Registry, Executor,
// a Flight, and the Tower — launches a single Flight, sends one user message,
// and streams the Flight's events to stdout. The HTTP/SSE server (task 22) is a
// separate surface; this command is a local smoke-test harness.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/bay"
	"github.com/wickedev/carrier/internal/engine"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/sq"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tool"
	"github.com/wickedev/carrier/internal/tower"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Bound the smoke-test run so it always exits even if the model stalls or
	// no API key is configured.
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	st, err := store.NewFileStore(filepath.Join(os.TempDir(), "carrier", "sessions"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "carrier: store: %v\n", err)
		os.Exit(1)
	}

	reg := tool.NewRegistry()
	reg.Register(tool.NewBash())

	// Pick the engine (the brain). Swap to engine.NewOpenAIEngine() to change
	// providers without touching the loop, the Tower, or the Bay.
	eng := engine.NewAnthropicEngine()

	f := flight.New(flight.Config{
		ID:     "flight-1",
		System: "You are a coding agent running inside Carrier.",
		Engine: eng,
		Store:  st,
		Tools:  reg,
		Exec:   tool.ExecContext{Executor: bay.NewLocalExecutor()},
	})

	tw := tower.New(64)
	fmt.Printf("carrier: launching %s on engine %q\n", f.ID(), eng.Name())
	if err := tw.Launch(ctx, f); err != nil {
		fmt.Fprintf(os.Stderr, "carrier: launch: %v\n", err)
		os.Exit(1)
	}

	if err := f.Queues().Submit(ctx, sq.Input{
		Msg:      agent.Message{Role: agent.RoleUser, Text: "Say hello."},
		Delivery: sq.Queue,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "carrier: submit: %v\n", err)
	}

	// Stream events until the Flight ends (its event channel closes on Run exit).
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
}
