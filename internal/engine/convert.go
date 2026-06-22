package engine

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// apiErrorMessage builds a stable human-readable message from an HTTP status
// code and the raw response body, without depending on the SDK error's
// String/Error method (which may dereference an unpopulated request/response).
func apiErrorMessage(status int, body string) string {
	msg := fmt.Sprintf("%d %s", status, http.StatusText(status))
	if body != "" {
		msg += ": " + body
	}
	return msg
}

// parseToolArguments decodes an OpenAI tool call's function.arguments — a JSON
// *string* — into a map. A blank or unparseable payload yields an empty map so
// callers never have to nil-check. Pure: unit-testable without a network.
func parseToolArguments(raw string) map[string]any {
	out := map[string]any{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// encodeToolArguments serializes a tool-call input map back into the JSON string
// form OpenAI expects on an assistant tool_calls echo. Pure.
func encodeToolArguments(input map[string]any) string {
	if len(input) == 0 {
		return "{}"
	}
	b, err := json.Marshal(input)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// decodeJSONObject decodes an already-parsed JSON object (Anthropic delivers
// tool_use input as raw JSON) into a map. Pure.
func decodeJSONObject(raw json.RawMessage) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

// toStringSlice coerces a []any (e.g. a JSON Schema "required" array) into
// []string, dropping non-string entries. Pure.
func toStringSlice(in []any) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// isContextOverflowMessage reports whether a provider error message indicates
// the prompt exceeded the model's context window. Pure.
func isContextOverflowMessage(msg string) bool {
	return containsAny(strings.ToLower(msg),
		"context length",
		"context window",
		"maximum context",
		"too many tokens",
		"prompt is too long",
		"reduce the length",
	)
}

// containsAny reports whether s contains any of the given substrings. Pure.
func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
