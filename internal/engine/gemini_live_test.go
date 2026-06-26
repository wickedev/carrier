package engine

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"

	"github.com/wickedev/carrier/internal/agent"
)

// redPNG returns a small solid-red PNG, base64-encoded.
func redPNG(t *testing.T) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 24, 24))
	for y := 0; y < 24; y++ {
		for x := 0; x < 24; x++ {
			img.Set(x, y, color.RGBA{R: 220, G: 20, B: 20, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

// TestGeminiRunStep_Live exercises the real Gemini engine. It is gated on
// CARRIER_GEMINI_LIVE=1 and the usual Vertex/Developer-API env so it never runs
// in CI without credentials.
func TestGeminiRunStep_Live(t *testing.T) {
	if os.Getenv("CARRIER_GEMINI_LIVE") == "" {
		t.Skip("CARRIER_GEMINI_LIVE not set; skipping live Gemini test")
	}
	eng, err := NewGeminiEngine()
	if err != nil {
		t.Fatalf("NewGeminiEngine: %v", err)
	}

	t.Run("plain", func(t *testing.T) {
		var sawText bool
		res, err := eng.RunStep(context.Background(), agent.StepInput{
			System:   "You are a terse assistant.",
			Messages: []agent.Message{{Role: agent.RoleUser, Text: "Say hello in one word."}},
			OnEvent: func(ev agent.StreamEvent) {
				if ev.Kind == agent.EvText && ev.Text != "" {
					sawText = true
				}
			},
		})
		if err != nil {
			t.Fatalf("RunStep: %v", err)
		}
		if !res.Done {
			t.Error("expected Done=true on a plain reply")
		}
		if res.Text == "" && !sawText {
			t.Error("expected some assistant text")
		}
		t.Logf("plain reply: %q (usage in=%d out=%d)", res.Text, res.Usage.InputTokens, res.Usage.OutputTokens)
	})

	t.Run("vision", func(t *testing.T) {
		// Simulate the conversation after view_image ran: the model called the
		// tool, and the tool returned an image. Now ask it what it sees. This
		// proves Vertex accepts the inline-image functionResponse.
		res, err := eng.RunStep(context.Background(), agent.StepInput{
			System: "Answer in one word.",
			Messages: []agent.Message{
				{Role: agent.RoleUser, Text: "Use view_image to look at it, then tell me the dominant color."},
				{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{
					{ID: "c1", Name: "view_image", Input: map[string]any{"path": "pic.png"}},
				}},
				{Role: agent.RoleTool, ToolCallID: "c1", Text: "Attached pic.png",
					Images: []agent.ImageData{{MediaType: "image/png", Base64: redPNG(t)}}},
			},
			Tools: []agent.Tool{{
				Name: "view_image", Description: "view an image",
				Schema: map[string]any{"type": "object", "properties": map[string]any{
					"path": map[string]any{"type": "string"},
				}},
			}},
		})
		if err != nil {
			t.Fatalf("vision RunStep: %v", err)
		}
		t.Logf("vision reply: %q", res.Text)
		if !strings.Contains(strings.ToLower(res.Text), "red") {
			t.Errorf("expected the model to identify the color as red, got %q", res.Text)
		}
	})
}
