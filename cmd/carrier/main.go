// Command carrier is the entrypoint for the Carrier agent runtime.
//
// This is an early skeleton: it wires a Tower, an Engine, and a Bay together and
// launches a single Flight. The HTTP/SSE server, job queue, and persistence
// layers are not built yet.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/bay"
	"github.com/wickedev/carrier/internal/engine"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/tower"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// The Fleet's control tower, capped at 64 concurrent Flights.
	tw := tower.New(64)

	// Pick the engine (the brain). Swap to engine.NewOpenAIEngine() to change
	// providers without touching the loop, the Tower, or the Bay.
	eng := engine.NewAnthropicEngine()

	// One Flight: an isolated coding session.
	f := flight.New(
		"flight-1",
		"You are a coding agent running inside Carrier.",
		demoTools(),
		eng,
		bay.NewLocalBay(),
	)

	fmt.Printf("carrier: launching %s on engine %q\n", f.ID, eng.Name())
	res := <-tw.Launch(ctx, f, "Say hello.")
	tw.Wait()

	if res.Err != nil {
		fmt.Fprintf(os.Stderr, "carrier: flight failed: %v\n", res.Err)
		os.Exit(1)
	}
	fmt.Println(res.Output)
}

// demoTools is a placeholder tool surface for the skeleton.
func demoTools() []agent.Tool {
	return []agent.Tool{
		{
			Name:        "run_command",
			Description: "Run a shell command in the Flight's sandbox bay.",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]any{"type": "string"},
				},
				"required": []string{"command"},
			},
		},
	}
}
