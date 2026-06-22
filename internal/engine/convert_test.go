package engine

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestParseToolArguments(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want map[string]any
	}{
		{"empty", "", map[string]any{}},
		{"blank", "   ", map[string]any{}},
		{"object", `{"city":"Seoul","n":2}`, map[string]any{"city": "Seoul", "n": float64(2)}},
		{"garbage", `not json`, map[string]any{}},
		{"empty-object", `{}`, map[string]any{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseToolArguments(c.raw)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("parseToolArguments(%q) = %#v, want %#v", c.raw, got, c.want)
			}
		})
	}
}

func TestEncodeToolArguments_RoundTrip(t *testing.T) {
	in := map[string]any{"city": "Seoul", "limit": float64(3)}
	encoded := encodeToolArguments(in)
	got := parseToolArguments(encoded)
	if !reflect.DeepEqual(got, in) {
		t.Fatalf("round-trip mismatch: got %#v, want %#v", got, in)
	}
}

func TestEncodeToolArguments_Empty(t *testing.T) {
	if got := encodeToolArguments(nil); got != "{}" {
		t.Fatalf("encodeToolArguments(nil) = %q, want {}", got)
	}
	if got := encodeToolArguments(map[string]any{}); got != "{}" {
		t.Fatalf("encodeToolArguments(empty) = %q, want {}", got)
	}
}

func TestDecodeJSONObject(t *testing.T) {
	got := decodeJSONObject(json.RawMessage(`{"a":1}`))
	want := map[string]any{"a": float64(1)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decodeJSONObject = %#v, want %#v", got, want)
	}
	if got := decodeJSONObject(nil); !reflect.DeepEqual(got, map[string]any{}) {
		t.Fatalf("decodeJSONObject(nil) = %#v, want empty map", got)
	}
}

func TestToStringSlice(t *testing.T) {
	got := toStringSlice([]any{"a", 1, "b", nil})
	want := []string{"a", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("toStringSlice = %#v, want %#v", got, want)
	}
}

func TestIsContextOverflowMessage(t *testing.T) {
	if !isContextOverflowMessage("This model's maximum context length is 200000 tokens") {
		t.Fatal("expected context-overflow detection")
	}
	if isContextOverflowMessage("invalid api key") {
		t.Fatal("did not expect context-overflow detection")
	}
}
