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
}

// StepInput is one model turn's request.
type StepInput struct {
	System   string
	Messages []Message
	Tools    []Tool

	// OnToken, if set, receives assistant text deltas as they stream.
	OnToken func(string)
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
// providers for unified cost tracking.
type Usage struct {
	InputTokens  int
	OutputTokens int
}
