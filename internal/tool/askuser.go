package tool

import "context"

// askUserTool lets the agent ask the user a question and wait for their answer.
// It is read-only (no effect on the world) so it stays available in plan mode.
// The answer is returned as the tool result.
type askUserTool struct{ Base }

// NewAskUser returns the ask_user tool.
func NewAskUser() *askUserTool {
	return &askUserTool{Base{
		ToolName: "ask_user",
		ToolDescription: "Ask the user a question and wait for their answer. Use when you need a " +
			"decision or missing information only the user can provide. Optionally offer choices " +
			"(suggested answers); the user may still reply freely.",
		ReadOnly: true,
		ToolSchema: obj(props{
			"question": strProp("The question to ask the user."),
			"choices":  arrProp("Optional suggested answers.", map[string]any{"type": "string"}),
		}, "question"),
	}}
}

func (askUserTool) Exec(ctx context.Context, input map[string]any, ec ExecContext) (Result, error) {
	question := strArg(input, "question")
	if question == "" {
		return errResult("missing required argument 'question'")
	}
	if ec.Asker == nil {
		return errResult("asking the user is not available in this context")
	}
	var choices []string
	if raw, ok := input["choices"].([]any); ok {
		for _, c := range raw {
			if s, ok := c.(string); ok && s != "" {
				choices = append(choices, s)
			}
		}
	}
	answer, err := ec.Asker.Ask(ctx, AskRequest{Prompt: question, Choices: choices})
	if err != nil {
		return errResult("%v", err)
	}
	return Result{Content: answer}, nil
}
