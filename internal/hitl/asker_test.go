package hitl

import (
	"context"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/tool"
)

func TestAskResolveDeliversAnswer(t *testing.T) {
	reqs := make(chan QuestionRequest, 1)
	a := NewAsker(func(q QuestionRequest) { reqs <- q }, time.Second)

	resultCh := make(chan string, 1)
	go func() {
		ans, _ := a.Ask(context.Background(), tool.AskRequest{Prompt: "color?", Choices: []string{"red", "blue"}})
		resultCh <- ans
	}()

	q := <-reqs
	if q.Prompt != "color?" || len(q.Choices) != 2 {
		t.Fatalf("unexpected question %+v", q)
	}
	if !a.Resolve(q.ID, "green") {
		t.Fatal("Resolve should succeed for a pending question")
	}
	if ans := <-resultCh; ans != "green" {
		t.Fatalf("expected answer 'green', got %q", ans)
	}
}

func TestAskTimeoutErrors(t *testing.T) {
	a := NewAsker(func(QuestionRequest) {}, 50*time.Millisecond)
	ans, err := a.Ask(context.Background(), tool.AskRequest{Prompt: "x"})
	if err == nil || ans != "" {
		t.Fatalf("expected timeout error, got ans=%q err=%v", ans, err)
	}
	if a.Pending() != 0 {
		t.Fatal("pending should be cleared after timeout")
	}
}

func TestAskContextCancel(t *testing.T) {
	a := NewAsker(func(QuestionRequest) {}, 0)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan error, 1)
	go func() {
		_, err := a.Ask(ctx, tool.AskRequest{Prompt: "x"})
		resultCh <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-resultCh; err == nil {
		t.Fatal("expected context cancellation error")
	}
}

func TestAskResolveUnknownID(t *testing.T) {
	a := NewAsker(func(QuestionRequest) {}, time.Second)
	if a.Resolve("nope", "x") {
		t.Fatal("resolving an unknown ID should return false")
	}
}

func TestSnapshotSurfacesPendingInOrder(t *testing.T) {
	a := NewAsker(func(QuestionRequest) {}, time.Second)
	// Two concurrent questions block; Snapshot must report both, ordered by Seq.
	go a.Ask(context.Background(), tool.AskRequest{Prompt: "first"})
	go a.Ask(context.Background(), tool.AskRequest{Prompt: "second", Choices: []string{"a"}})

	deadline := time.After(time.Second)
	var snap []QuestionRequest
	for {
		snap = a.Snapshot()
		if len(snap) == 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected 2 pending questions, got %d", len(snap))
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if snap[0].Seq >= snap[1].Seq {
		t.Fatalf("snapshot not ordered by seq: %+v", snap)
	}
	// Resolving one drops it from the snapshot; the other survives.
	if !a.Resolve(snap[0].ID, "x") {
		t.Fatal("resolve of a pending question should succeed")
	}
	// Resolving removes the channel-receive side; give Ask a moment to return and
	// clear its pending entry, then confirm only one remains.
	for i := 0; i < 100; i++ {
		if a.Pending() == 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("expected 1 pending after resolve, got %d", a.Pending())
}
