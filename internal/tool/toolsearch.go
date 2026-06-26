package tool

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// toolSearchTool lets the model discover tools that are not advertised by
// default (Exposure Deferred) and make them callable. This keeps the default
// tool list — and thus the prompt — small while a larger pool stays reachable on
// demand: a search reveals matching tools, which then appear in the model's tool
// list on the next turn.
type toolSearchTool struct {
	Base
	reg *Registry
}

// NewToolSearch returns the tool_search tool bound to a registry.
func NewToolSearch(reg *Registry) *toolSearchTool {
	return &toolSearchTool{
		Base: Base{
			ToolName: "tool_search",
			ToolDescription: "Find tools that aren't loaded by default and make them available. Use " +
				"when you need a capability you don't see in your current tools (describe the task or " +
				"capability). Matching tools become callable on your next step.",
			ReadOnly: true,
			ToolSchema: obj(props{
				"query":       strProp("The task or capability you need (e.g. \"edit a Jupyter notebook\")."),
				"max_results": intProp("Maximum tools to return (default 5)."),
			}, "query"),
		},
		reg: reg,
	}
}

func (t *toolSearchTool) Exec(_ context.Context, input map[string]any, _ ExecContext) (Result, error) {
	query := strArg(input, "query")
	if query == "" {
		return errResult("missing required argument 'query'")
	}
	max := 5
	if n, ok := intArg(input, "max_results"); ok && n > 0 {
		max = n
	}

	matches := searchTools(t.reg.Deferred(), query, max)
	if len(matches) == 0 {
		return Result{Content: fmt.Sprintf("No additional tools match %q.", query)}, nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Loaded %d tool(s); you can call them now:\n", len(matches))
	for _, m := range matches {
		t.reg.Reveal(m.Name())
		fmt.Fprintf(&b, "- %s: %s\n", m.Name(), m.Description())
	}
	return Result{Content: strings.TrimRight(b.String(), "\n")}, nil
}

// searchTools ranks the pool by how many query terms appear in each tool's name
// or description (case-insensitive), returning up to max with a positive score.
// Trivial query words (< 3 chars, e.g. "a", "to") are ignored so they can't
// spuriously match common substrings.
func searchTools(pool []Tool, query string, max int) []Tool {
	var terms []string
	for _, w := range strings.Fields(strings.ToLower(query)) {
		if len(w) >= 3 {
			terms = append(terms, w)
		}
	}
	type scored struct {
		t Tool
		s int
	}
	ranked := make([]scored, 0, len(pool))
	for _, tl := range pool {
		hay := strings.ToLower(tl.Name() + " " + tl.Description())
		score := 0
		for _, term := range terms {
			if strings.Contains(hay, term) {
				score++
			}
		}
		if score > 0 {
			ranked = append(ranked, scored{tl, score})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].s != ranked[j].s {
			return ranked[i].s > ranked[j].s
		}
		return ranked[i].t.Name() < ranked[j].t.Name()
	})
	out := make([]Tool, 0, max)
	for i := 0; i < len(ranked) && i < max; i++ {
		out = append(out, ranked[i].t)
	}
	return out
}
