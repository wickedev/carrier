// Package agent defines the provider-agnostic types that flow through a Flight.
//
// Engines (provider adapters) translate between these types and a vendor SDK;
// the Flight loop and the Tower never see vendor-specific shapes. This package
// is the single contract the whole Fleet speaks.
package agent

// Role identifies who produced a Message.
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// Message is one normalized turn in a conversation.
//
// A turn is exactly one of: plain text (user or assistant), a set of tool calls
// the model wants run (assistant), or a tool result fed back (tool). Engines map
// these onto each provider's native message shape.
type Message struct {
	Role Role

	// Text holds plain user/assistant content, or — on a RoleTool turn — the
	// tool's result.
	Text string

	// ToolCalls is set on an assistant turn where the model requested tools.
	ToolCalls []ToolCall

	// ToolCallID links a RoleTool turn back to the ToolCall it answers.
	ToolCallID string

	// Images carries image content on a RoleTool turn (e.g. from view_image), so
	// a tool can attach pictures to the model's context. Engines whose provider
	// supports vision render these as image blocks; others drop them.
	Images []ImageData
}

// ImageData is a base64-encoded image attached to model context. MediaType is an
// IANA type such as "image/png" or "image/jpeg".
type ImageData struct {
	MediaType string
	Base64    string
}

// ToolCall is the model's request to run a single tool.
type ToolCall struct {
	ID    string
	Name  string
	Input map[string]any
}

// Tool is a tool definition advertised to the model.
type Tool struct {
	Name        string
	Description string
	// Schema is a JSON Schema object describing the tool's input.
	Schema map[string]any
	// Native, when non-empty, names a provider-hosted server tool (e.g.
	// "web_search") that the Engine injects in its provider-native form. The
	// provider executes it server-side and folds results into the turn — the
	// Flight never dispatches it locally, so Schema is advisory only. An Engine
	// whose provider can't host the named tool simply drops it (doesn't
	// advertise it).
	Native string
}

// StepInput is one model turn's request.
type StepInput struct {
	System   string
	Messages []Message
	Tools    []Tool

	// Model, when non-empty, overrides the Engine's default model for this turn
	// (per-session model selection). Effort, when non-empty, selects the
	// reasoning effort level where the provider supports it.
	Model  string
	Effort string

	// OnEvent, if set, receives canonical StreamEvents as the turn streams.
	// The Engine emits events through this callback; the aggregated outcome is
	// still returned as a StepResult.
	OnEvent func(StreamEvent)
}

// StepResult is the normalized outcome of one model turn.
type StepResult struct {
	// Text is the assistant's prose for this turn (may be empty on a pure
	// tool-call turn).
	Text string

	// ToolCalls are the tools the model wants executed before continuing.
	ToolCalls []ToolCall

	// Done is true when the model finished without requesting tools.
	Done bool

	Usage Usage
}

// Usage reports token consumption for a single step, normalized across
// providers for unified cost tracking. Cache tokens are tracked separately from
// input/output because they are priced differently and matter for prompt-cache
// economics.
type Usage struct {
	InputTokens      int
	OutputTokens     int
	CacheReadTokens  int
	CacheWriteTokens int
	ReasoningTokens  int
}

// Add returns the element-wise sum of two Usage values, for accumulating a
// turn's usage across multiple stream events.
func (u Usage) Add(o Usage) Usage {
	return Usage{
		InputTokens:      u.InputTokens + o.InputTokens,
		OutputTokens:     u.OutputTokens + o.OutputTokens,
		CacheReadTokens:  u.CacheReadTokens + o.CacheReadTokens,
		CacheWriteTokens: u.CacheWriteTokens + o.CacheWriteTokens,
		ReasoningTokens:  u.ReasoningTokens + o.ReasoningTokens,
	}
}
