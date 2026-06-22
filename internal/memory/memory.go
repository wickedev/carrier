// Package memory discovers durable project instruction files (AGENTS.md /
// CLAUDE.md) by walking up from a working directory. The result is injected into
// a Flight ahead of the conversation (via flight.Config.Memory) so it persists
// outside the mutable, compactable history.
package memory

import (
	"os"
	"path/filepath"
	"strings"
)

// instructionFiles are the recognized instruction file names, checked in order
// within each directory.
var instructionFiles = []string{"AGENTS.md", "CLAUDE.md"}

// DefaultMaxBytes caps the total injected instruction size.
const DefaultMaxBytes = 32 * 1024

// LoadInstructions walks from startDir up to the filesystem root, collecting the
// first matching instruction file in each directory. Outer (less specific)
// directories come first so the nearest, most specific instructions appear last.
// Each file is included at most once; the total is capped at maxBytes (0 →
// DefaultMaxBytes).
func LoadInstructions(startDir string, maxBytes int) (string, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	abs, err := filepath.Abs(startDir)
	if err != nil {
		return "", err
	}

	// Collect directories from startDir up to root.
	var dirs []string
	for {
		dirs = append(dirs, abs)
		parent := filepath.Dir(abs)
		if parent == abs {
			break
		}
		abs = parent
	}

	// Visit outermost (root) first so the nearest file is appended last.
	seen := make(map[string]bool)
	var blocks []string
	total := 0
	for i := len(dirs) - 1; i >= 0; i-- {
		path, content, ok := readInstruction(dirs[i])
		if !ok || seen[path] {
			continue
		}
		seen[path] = true
		block := "# " + path + "\n\n" + content
		if total+len(block) > maxBytes {
			remaining := maxBytes - total
			if remaining <= 0 {
				break
			}
			block = block[:remaining]
			blocks = append(blocks, block)
			break
		}
		blocks = append(blocks, block)
		total += len(block)
	}
	return strings.Join(blocks, "\n\n"), nil
}

// readInstruction returns the first recognized instruction file in dir.
func readInstruction(dir string) (path, content string, ok bool) {
	for _, name := range instructionFiles {
		p := filepath.Join(dir, name)
		b, err := os.ReadFile(p)
		if err == nil {
			return p, string(b), true
		}
	}
	return "", "", false
}
