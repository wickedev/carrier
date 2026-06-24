package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tower"
)

// multiEventEngine emits several live events in one turn (two text deltas then a
// title), so a test can verify each live event gets a distinct, increasing seq.
type multiEventEngine struct{}

func (multiEventEngine) Name() string { return "multi" }

func (multiEventEngine) RunStep(_ context.Context, in agent.StepInput) (agent.StepResult, error) {
	if in.OnEvent != nil {
		in.OnEvent(agent.StreamEvent{Kind: agent.EvText, Text: "alpha"})
		in.OnEvent(agent.StreamEvent{Kind: agent.EvText, Text: "beta"})
		in.OnEvent(agent.StreamEvent{Kind: agent.EvTitleSuggested, Title: "Fix The Login"})
	}
	return agent.StepResult{Text: "alpha beta", Done: true}, nil
}

// TestLiveEventsGetMonotonicSeq is the regression guard for the bug where every
// live event serialized as seq 0, so a seq-deduping consumer dropped all but the
// first — silently losing live text and the auto-generated title.
func TestLiveEventsGetMonotonicSeq(t *testing.T) {
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	tw := tower.New(8)
	factory := func(sid, tenant string, opts SessionOptions) (*flight.Flight, func()) {
		return flight.New(flight.Config{
			ID: sid, System: "t", Engine: multiEventEngine{}, Store: st,
		}), nil
	}
	srv := New(tw, factory, st, map[string]string{"tok": "default"})
	t.Cleanup(srv.Shutdown)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	sid := createSession(t, ts, "tok")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp := openEvents(t, ctx, ts, "tok", sid)
	defer resp.Body.Close()

	if code := postInput(t, ts, "tok", sid, "the login button does nothing", false); code != http.StatusAccepted {
		t.Fatalf("input status = %d", code)
	}

	// Collect live events (those carrying our text / a title) until we see the
	// title, recording their seqs.
	var seqs []int
	var sawTitle bool
	var titleSeq int
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var dto eventDTO
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &dto); err != nil {
			continue
		}
		switch {
		case dto.Kind == "text" && (strings.Contains(dto.Text, "alpha") || strings.Contains(dto.Text, "beta")):
			seqs = append(seqs, dto.Seq)
		case dto.Kind == "title_suggested":
			sawTitle = true
			titleSeq = dto.Seq
			seqs = append(seqs, dto.Seq)
		}
		if sawTitle {
			break
		}
	}

	if !sawTitle {
		t.Fatal("never observed the live title event")
	}
	if len(seqs) < 2 {
		t.Fatalf("expected multiple live events, got seqs %v", seqs)
	}
	// Every live seq must be distinct and strictly increasing (the bug made them
	// all 0). In particular the title (a later live event) must NOT collide.
	for i := 1; i < len(seqs); i++ {
		if seqs[i] <= seqs[i-1] {
			t.Fatalf("live seqs not strictly increasing: %v", seqs)
		}
	}
	if titleSeq <= 0 {
		t.Fatalf("title seq = %d, want > 0", titleSeq)
	}
}
