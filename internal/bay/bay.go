// Package bay is the Carrier's hangar deck: the isolated environment where a
// Flight's tool calls execute, separate from the Carrier process. Code
// execution and file operations run here (Docker / E2B), never in the
// orchestrator.
package bay

import (
	"context"
	"fmt"
)

// Bay is an isolated execution environment for one Flight's tool calls.
type Bay interface {
	// Exec runs a named tool with its parsed input and returns the result text
	// that will be fed back to the model.
	Exec(ctx context.Context, tool string, input map[string]any) (string, error)

	// Close tears down the environment (container, workspace).
	Close() error
}

// LocalBay is a placeholder Bay that executes nothing yet. Replace it with a
// Docker- or E2B-backed implementation that provisions a per-Flight sandbox.
type LocalBay struct{}

// NewLocalBay returns a no-op Bay used during early development.
func NewLocalBay() *LocalBay { return &LocalBay{} }

// Exec implements Bay.
func (b *LocalBay) Exec(ctx context.Context, tool string, input map[string]any) (string, error) {
	return "", fmt.Errorf("bay: tool %q not implemented (no sandbox wired yet)", tool)
}

// Close implements Bay.
func (b *LocalBay) Close() error { return nil }
