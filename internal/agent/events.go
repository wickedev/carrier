package agent

// EventKind classifies a StreamEvent emitted during one model turn.
type EventKind int

const (
	EvText            EventKind = iota // assistant text delta
	EvReasoning                        // reasoning/thinking delta
	EvToolInputDelta                   // partial tool-call argument delta
	EvToolCall                         // a complete tool call the model wants run
	EvToolResult                       // the result of a tool call, fed back
	EvStepStart                        // a model turn began
	EvStepFinish                       // a model turn finished (carries Usage)
	EvUsage                            // an incremental usage update
	EvError                            // a classified engine error
	EvApprovalRequest                  // a tool action awaiting human approval
)

// StreamEvent is the canonical, provider-agnostic unit of streaming output.
//
// Every Engine maps its native stream into a sequence of StreamEvents; nothing
// above the Engine branches on the provider. Exactly one of the pointer fields
// is set, determined by Kind.
type StreamEvent struct {
	Kind EventKind

	// Text carries the delta for EvText and EvReasoning.
	Text string

	// ToolCall is set for EvToolCall.
	ToolCall *ToolCall

	// Result is set for EvToolResult.
	Result *ToolResult

	// Usage is set for EvUsage and EvStepFinish.
	Usage *Usage

	// Err is set for EvError.
	Err *EngineError

	// Approval is set for EvApprovalRequest.
	Approval *ApprovalRequest
}

// ToolResult is the outcome of executing a ToolCall, normalized for feedback to
// the model.
type ToolResult struct {
	ToolCallID string
	Content    string
	IsError    bool
}

// ApprovalRequest is a tool action surfaced to a human for approval, carried on
// an EvApprovalRequest event and correlated back by ReqID.
type ApprovalRequest struct {
	ReqID    string
	Tool     string
	Resource string
	Reason   string
}

func (k EventKind) String() string {
	switch k {
	case EvText:
		return "text"
	case EvReasoning:
		return "reasoning"
	case EvToolInputDelta:
		return "tool_input_delta"
	case EvToolCall:
		return "tool_call"
	case EvToolResult:
		return "tool_result"
	case EvStepStart:
		return "step_start"
	case EvStepFinish:
		return "step_finish"
	case EvUsage:
		return "usage"
	case EvError:
		return "error"
	case EvApprovalRequest:
		return "approval_request"
	default:
		return "unknown"
	}
}
