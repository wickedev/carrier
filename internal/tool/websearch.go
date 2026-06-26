package tool

import "context"

// webSearchTool is a provider-hosted web search. Unlike ordinary tools it is not
// dispatched locally: the Engine injects it in its provider-native form (e.g.
// Anthropic's web_search_20250305 server tool, the OpenAI Responses API
// web_search tool) and the provider runs the search and folds results into the
// turn. Registering it advertises the capability to providers that support it;
// engines whose provider can't host it drop it.
//
// It is read-only (safe in plan mode) and concurrency-safe. Native() marks it so
// the Flight forwards it to the Engine as a native tool rather than a function
// tool, and never calls Exec.
type webSearchTool struct{ Base }

// NewWebSearch returns the web_search tool.
func NewWebSearch() *webSearchTool {
	return &webSearchTool{Base{
		ToolName: "web_search",
		ToolDescription: "Search the web for up-to-date information beyond the training cutoff. " +
			"Runs server-side at the model provider; results are returned inline with citations.",
		ReadOnly:        true,
		ConcurrencySafe: true,
		// Advisory only — the provider defines the real input shape for its hosted
		// search tool. Kept so the capability reads sensibly in tool listings.
		ToolSchema: obj(props{
			"query": strProp("The search query."),
		}, "query"),
	}}
}

// Native marks this as the provider-hosted "web_search" tool.
func (webSearchTool) Native() string { return "web_search" }

// Exec is never reached: a native tool is executed by the provider, not
// dispatched by the Flight. It returns an error if somehow invoked directly.
func (webSearchTool) Exec(_ context.Context, _ map[string]any, _ ExecContext) (Result, error) {
	return errResult("web_search is a provider-hosted tool and is not executed locally")
}
