package engine

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"

	"google.golang.org/genai"

	"github.com/wickedev/carrier/internal/agent"
)

// GeminiEngine adapts Google's Gemini (via the unified google.golang.org/genai
// SDK) to the Engine contract. One client speaks BOTH backends — the Gemini
// Developer API (GEMINI_API_KEY / GOOGLE_API_KEY) and Vertex AI
// (GOOGLE_GENAI_USE_VERTEXAI=1 + GOOGLE_CLOUD_PROJECT / _LOCATION) — selected by
// ClientConfig/env, so the same engine serves either with no code change.
//
// Normalization notes the adapter bridges:
//   - roles are only "user"/"model"; the system prompt is a separate
//     SystemInstruction, and tool results ride back as a user turn carrying a
//     functionResponse part;
//   - tool calls/results correlate by function NAME, so a tool turn looks up the
//     name of the call it answers;
//   - images attach directly inside the functionResponse (inline blob parts);
//   - completion is implicit: a turn with no functionCall part is done.
type GeminiEngine struct {
	Model  string
	client *genai.Client
}

const defaultGeminiModel = "gemini-2.5-pro"

// NewGeminiEngine builds a Gemini engine. With an empty ClientConfig the SDK
// resolves the backend and credentials from the environment (Developer API by
// default; Vertex when GOOGLE_GENAI_USE_VERTEXAI is set).
func NewGeminiEngine() (*GeminiEngine, error) {
	client, err := genai.NewClient(context.Background(), &genai.ClientConfig{})
	if err != nil {
		return nil, err
	}
	return &GeminiEngine{Model: defaultGeminiModel, client: client}, nil
}

// Name implements Engine.
func (e *GeminiEngine) Name() string { return "gemini" }

// RunStep implements Engine: one streamed Gemini turn → an agent.StepResult.
func (e *GeminiEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	model := e.Model
	if in.Model != "" {
		model = in.Model // per-session model override
	}
	if model == "" {
		model = defaultGeminiModel
	}

	cfg := &genai.GenerateContentConfig{Tools: geminiTools(in.Tools)}
	if in.System != "" {
		cfg.SystemInstruction = genai.NewContentFromText(in.System, genai.RoleUser)
	}

	emit := in.OnEvent
	if emit == nil {
		emit = func(agent.StreamEvent) {}
	}
	emit(agent.StreamEvent{Kind: agent.EvStepStart})

	var result agent.StepResult
	var usage agent.Usage
	for resp, err := range e.client.Models.GenerateContentStream(ctx, model, geminiContents(in.Messages), cfg) {
		if err != nil {
			if ctx.Err() != nil {
				return agent.StepResult{}, ctx.Err()
			}
			return agent.StepResult{}, classifyGeminiError(err)
		}
		for _, cand := range resp.Candidates {
			if cand.Content == nil {
				continue
			}
			for _, p := range cand.Content.Parts {
				switch {
				case p.Text != "" && p.Thought:
					emit(agent.StreamEvent{Kind: agent.EvReasoning, Text: p.Text})
				case p.Text != "":
					result.Text += p.Text
					emit(agent.StreamEvent{Kind: agent.EvText, Text: p.Text})
				case p.FunctionCall != nil:
					id := p.FunctionCall.ID
					if id == "" {
						id = fmt.Sprintf("%s-%d", p.FunctionCall.Name, len(result.ToolCalls))
					}
					tc := agent.ToolCall{ID: id, Name: p.FunctionCall.Name, Input: p.FunctionCall.Args}
					result.ToolCalls = append(result.ToolCalls, tc)
					call := tc
					emit(agent.StreamEvent{Kind: agent.EvToolCall, ToolCall: &call})
				}
			}
		}
		if resp.UsageMetadata != nil {
			usage = geminiUsage(resp.UsageMetadata)
		}
	}

	result.Done = len(result.ToolCalls) == 0
	result.Usage = usage
	emit(agent.StreamEvent{Kind: agent.EvUsage, Usage: &usage})
	emit(agent.StreamEvent{Kind: agent.EvStepFinish, Usage: &usage})
	return result, nil
}

// geminiTools converts canonical tool defs into Gemini function declarations.
// Provider-native tools (e.g. web_search) are dropped: Gemini's GoogleSearch
// grounding cannot be combined with function calling in one request, and the
// function tools are essential — so we never risk breaking them. Pure.
func geminiTools(tools []agent.Tool) []*genai.Tool {
	var fns []*genai.FunctionDeclaration
	for _, t := range tools {
		if t.Native != "" {
			continue
		}
		fns = append(fns, &genai.FunctionDeclaration{
			Name:                 t.Name,
			Description:          t.Description,
			ParametersJsonSchema: t.Schema,
		})
	}
	if len(fns) == 0 {
		return nil
	}
	return []*genai.Tool{{FunctionDeclarations: fns}}
}

// geminiContents converts canonical conversation turns into Gemini Contents.
// Tool results correlate by function NAME, so it tracks each call's name from
// the assistant turn that requested it. Attached images ride inside the
// functionResponse as inline blob parts. Pure: no network.
func geminiContents(msgs []agent.Message) []*genai.Content {
	callNames := make(map[string]string) // ToolCallID → function name
	out := make([]*genai.Content, 0, len(msgs))
	for _, m := range msgs {
		switch m.Role {
		case agent.RoleUser:
			out = append(out, genai.NewContentFromText(m.Text, genai.RoleUser))
		case agent.RoleAssistant:
			parts := make([]*genai.Part, 0, 1+len(m.ToolCalls))
			if m.Text != "" {
				parts = append(parts, &genai.Part{Text: m.Text})
			}
			for _, tc := range m.ToolCalls {
				callNames[tc.ID] = tc.Name
				parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{
					ID: tc.ID, Name: tc.Name, Args: tc.Input,
				}})
			}
			if len(parts) == 0 {
				continue
			}
			out = append(out, &genai.Content{Role: genai.RoleModel, Parts: parts})
		case agent.RoleTool:
			name := callNames[m.ToolCallID]
			if name == "" {
				name = m.ToolCallID // best effort if the call wasn't seen
			}
			fr := &genai.FunctionResponse{
				ID:       m.ToolCallID,
				Name:     name,
				Response: map[string]any{"output": m.Text},
			}
			out = append(out, &genai.Content{
				Role:  genai.RoleUser,
				Parts: []*genai.Part{{FunctionResponse: fr}},
			})
			// Images can't ride inside the functionResponse (the model rejects
			// `function_response.parts`); attach them as a following user turn of
			// inline-data parts, which vision models accept.
			if imgParts := geminiImageParts(m.Images); len(imgParts) > 0 {
				out = append(out, &genai.Content{Role: genai.RoleUser, Parts: imgParts})
			}
		}
	}
	return out
}

// geminiImageParts renders attached images as inline-data content parts (raw
// bytes; the agent layer holds them base64-encoded). Returns nil for none.
func geminiImageParts(imgs []agent.ImageData) []*genai.Part {
	if len(imgs) == 0 {
		return nil
	}
	parts := make([]*genai.Part, 0, len(imgs))
	for _, img := range imgs {
		data, err := base64.StdEncoding.DecodeString(img.Base64)
		if err != nil {
			continue // skip an undecodable image rather than fail the turn
		}
		parts = append(parts, &genai.Part{
			InlineData: &genai.Blob{MIMEType: img.MediaType, Data: data},
		})
	}
	return parts
}

// geminiUsage normalizes Gemini usage metadata into the canonical Usage. Pure.
func geminiUsage(u *genai.GenerateContentResponseUsageMetadata) agent.Usage {
	if u == nil {
		return agent.Usage{}
	}
	return agent.Usage{
		InputTokens:     int(u.PromptTokenCount),
		OutputTokens:    int(u.CandidatesTokenCount),
		CacheReadTokens: int(u.CachedContentTokenCount),
		ReasoningTokens: int(u.ThoughtsTokenCount),
	}
}

// classifyGeminiError translates an SDK error into a typed *agent.EngineError.
func classifyGeminiError(err error) error {
	if err == nil {
		return nil
	}
	var apiErr genai.APIError
	if !errors.As(err, &apiErr) {
		return &agent.EngineError{
			Class:    agent.ErrRetryable,
			Provider: "gemini",
			Message:  err.Error(),
			Err:      err,
		}
	}
	ee := &agent.EngineError{Provider: "gemini", Message: apiErr.Message, Err: err}
	switch {
	case apiErr.Code == http.StatusTooManyRequests:
		ee.Class = agent.ErrRateLimited
	case apiErr.Code == http.StatusRequestEntityTooLarge:
		ee.Class = agent.ErrContextOverflow
	case apiErr.Code == http.StatusPaymentRequired || apiErr.Code == http.StatusForbidden:
		ee.Class = agent.ErrQuotaExceeded
	case apiErr.Code >= 500:
		ee.Class = agent.ErrRetryable
	default:
		ee.Class = agent.ErrFatal
	}
	return ee
}
