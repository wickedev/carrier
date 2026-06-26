package tool

import (
	"context"
	"testing"
)

type fakeAsker struct {
	gotReq AskRequest
	answer string
	err    error
}

func (f *fakeAsker) Ask(_ context.Context, req AskRequest) (string, error) {
	f.gotReq = req
	return f.answer, f.err
}

func TestAskUserReturnsAnswer(t *testing.T) {
	fa := &fakeAsker{answer: "blue"}
	res, err := NewAskUser().Exec(context.Background(),
		map[string]any{"question": "color?", "choices": []any{"red", "blue", ""}},
		ExecContext{Asker: fa})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.IsError || res.Content != "blue" {
		t.Fatalf("unexpected result %+v", res)
	}
	if fa.gotReq.Prompt != "color?" || len(fa.gotReq.Choices) != 2 {
		t.Fatalf("empty choice not filtered: %+v", fa.gotReq)
	}
}

func TestAskUserMissingQuestion(t *testing.T) {
	res, _ := NewAskUser().Exec(context.Background(),
		map[string]any{}, ExecContext{Asker: &fakeAsker{}})
	if !res.IsError {
		t.Fatal("expected error for missing question")
	}
}

func TestAskUserNoAsker(t *testing.T) {
	res, _ := NewAskUser().Exec(context.Background(),
		map[string]any{"question": "hi"}, ExecContext{})
	if !res.IsError {
		t.Fatal("expected error when no Asker is configured")
	}
}
