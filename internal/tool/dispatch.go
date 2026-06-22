package tool

import (
	"context"
	"fmt"
	"sync"

	"golang.org/x/sync/semaphore"

	"github.com/wickedev/carrier/internal/agent"
)

// DefaultMaxParallel bounds how many concurrency-safe tools run at once.
const DefaultMaxParallel = 10

// Dispatch executes a turn's tool calls, partitioning them into consecutive
// batches by concurrency-safety: a run of safe calls executes in a bounded
// parallel pool, while an unsafe call is a serial barrier. Model-intended order
// is preserved; exactly one ToolResult is produced per call, matched by ID.
//
// Tool failures (unknown tool, Exec error) become error results fed back to the
// model rather than aborting the turn.
func Dispatch(ctx context.Context, calls []agent.ToolCall, reg *Registry, ec ExecContext, maxParallel int) []agent.ToolResult {
	if maxParallel < 1 {
		maxParallel = DefaultMaxParallel
	}
	results := make([]agent.ToolResult, len(calls))

	i := 0
	for i < len(calls) {
		safe := callIsConcurrencySafe(calls[i], reg)
		j := i + 1
		for j < len(calls) && callIsConcurrencySafe(calls[j], reg) == safe {
			j++
		}
		if safe && j-i > 1 {
			runBatchParallel(ctx, calls[i:j], i, results, reg, ec, maxParallel)
		} else {
			for k := i; k < j; k++ {
				results[k] = runOne(ctx, calls[k], reg, ec)
			}
		}
		i = j
	}
	return results
}

func callIsConcurrencySafe(c agent.ToolCall, reg *Registry) bool {
	t, ok := reg.Get(c.Name)
	if !ok {
		return false // unknown tools are serial (fail-closed)
	}
	return t.IsConcurrencySafe(c.Input)
}

func runBatchParallel(ctx context.Context, batch []agent.ToolCall, base int, results []agent.ToolResult, reg *Registry, ec ExecContext, maxParallel int) {
	sem := semaphore.NewWeighted(int64(maxParallel))
	var wg sync.WaitGroup
	for k := range batch {
		if err := sem.Acquire(ctx, 1); err != nil {
			// ctx cancelled while acquiring — record cancellation for the rest.
			results[base+k] = agent.ToolResult{
				ToolCallID: batch[k].ID,
				Content:    fmt.Sprintf("error: %v", err),
				IsError:    true,
			}
			continue
		}
		wg.Add(1)
		go func(idx int, c agent.ToolCall) {
			defer wg.Done()
			defer sem.Release(1)
			results[base+idx] = runOne(ctx, c, reg, ec)
		}(k, batch[k])
	}
	wg.Wait()
}

func runOne(ctx context.Context, c agent.ToolCall, reg *Registry, ec ExecContext) agent.ToolResult {
	t, ok := reg.Get(c.Name)
	if !ok {
		return agent.ToolResult{
			ToolCallID: c.ID,
			Content:    fmt.Sprintf("error: unknown tool %q", c.Name),
			IsError:    true,
		}
	}
	res, err := t.Exec(ctx, c.Input, ec)
	if err != nil {
		return agent.ToolResult{
			ToolCallID: c.ID,
			Content:    fmt.Sprintf("error: %v", err),
			IsError:    true,
		}
	}
	content := res.Content
	// Spill oversized results, substituting a bounded preview.
	if ec.Spiller != nil && ec.MaxResultBytes > 0 && len(content) > ec.MaxResultBytes {
		if preview, serr := ec.Spiller.Spill(c.ID, content); serr == nil {
			content = preview
		} else {
			content = content[:ec.MaxResultBytes]
		}
	}
	return agent.ToolResult{ToolCallID: c.ID, Content: content, IsError: res.IsError}
}
