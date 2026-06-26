package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tool"
	"github.com/wickedev/carrier/internal/tower"
)

// fakeEngine is a tiny Engine that emits one text event and returns a Done
// StepResult. It never calls a real provider.
type fakeEngine struct{ reply string }

func (e fakeEngine) Name() string { return "fake" }

func (e fakeEngine) RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error) {
	if in.OnEvent != nil {
		in.OnEvent(agent.StreamEvent{Kind: agent.EvText, Text: e.reply})
	}
	return agent.StepResult{Text: e.reply, Done: true}, nil
}

// newTestServer wires a Server over a real FileStore and a fake-engine Factory.
func newTestServer(t *testing.T, tokens map[string]string) (*Server, store.Store) {
	t.Helper()
	st, err := store.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	tw := tower.New(16)
	factory := func(sid, tenant string, opts SessionOptions) (*flight.Flight, func()) {
		f := flight.New(flight.Config{
			ID:     sid,
			System: "test",
			Engine: fakeEngine{reply: "hello from fake"},
			Store:  st,
		})
		return f, nil
	}
	srv := New(tw, factory, st, tokens)
	// Stop every Flight goroutine before the t.TempDir() FileStore is removed, so
	// no late append races with cleanup.
	t.Cleanup(srv.Shutdown)
	return srv, st
}

func createSession(t *testing.T, ts *httptest.Server, token string) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/sessions", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, want 200", resp.StatusCode)
	}
	var cr createResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if cr.SessionID == "" {
		t.Fatal("empty session_id")
	}
	return cr.SessionID
}

func postInput(t *testing.T, ts *httptest.Server, token, sid, text string, steer bool) int {
	t.Helper()
	body, _ := json.Marshal(inputRequest{Text: text, Steer: steer})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/sessions/"+sid+"/input", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("input: %v", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// openEvents opens an SSE stream and returns the response. The caller must close
// resp.Body. ctx bounds the read so the test cannot hang.
func openEvents(t *testing.T, ctx context.Context, ts *httptest.Server, token, sid string) *http.Response {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/sessions/"+sid+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	return resp
}

// readUntilText scans SSE data lines until one DTO's text contains want, or the
// stream/context ends. It reports whether want was seen.
func readUntilText(r io.Reader, want string) bool {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var dto eventDTO
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &dto); err != nil {
			continue
		}
		if strings.Contains(dto.Text, want) {
			return true
		}
	}
	return false
}

func TestCreateInputStream(t *testing.T) {
	srv, _ := newTestServer(t, map[string]string{"tok-a": "tenant-a"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	sid := createSession(t, ts, "tok-a")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp := openEvents(t, ctx, ts, "tok-a", sid)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("events status = %d, want 200", resp.StatusCode)
	}

	if code := postInput(t, ts, "tok-a", sid, "hi", false); code != http.StatusAccepted {
		t.Fatalf("input status = %d, want 202", code)
	}

	if !readUntilText(resp.Body, "hello from fake") {
		t.Fatal("did not observe fake reply text in SSE stream")
	}
}

func TestFanOutTwoSubscribers(t *testing.T) {
	srv, _ := newTestServer(t, map[string]string{"tok-a": "tenant-a"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	sid := createSession(t, ts, "tok-a")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r1 := openEvents(t, ctx, ts, "tok-a", sid)
	defer r1.Body.Close()
	r2 := openEvents(t, ctx, ts, "tok-a", sid)
	defer r2.Body.Close()

	if code := postInput(t, ts, "tok-a", sid, "hi", false); code != http.StatusAccepted {
		t.Fatalf("input status = %d, want 202", code)
	}

	got1 := make(chan bool, 1)
	got2 := make(chan bool, 1)
	go func() { got1 <- readUntilText(r1.Body, "hello from fake") }()
	go func() { got2 <- readUntilText(r2.Body, "hello from fake") }()

	for i, ch := range []chan bool{got1, got2} {
		select {
		case ok := <-ch:
			if !ok {
				t.Fatalf("subscriber %d did not receive event", i+1)
			}
		case <-ctx.Done():
			t.Fatalf("subscriber %d timed out", i+1)
		}
	}
}

func TestUnknownTokenUnauthorized(t *testing.T) {
	srv, _ := newTestServer(t, map[string]string{"tok-a": "tenant-a"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/sessions", nil)
	req.Header.Set("Authorization", "Bearer nope")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestNoAuthHeaderUnauthorized(t *testing.T) {
	srv, _ := newTestServer(t, map[string]string{"tok-a": "tenant-a"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/v1/sessions", "application/json", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestCrossTenantForbidden(t *testing.T) {
	srv, _ := newTestServer(t, map[string]string{"tok-a": "tenant-a", "tok-b": "tenant-b"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// tenant-a creates the session.
	sid := createSession(t, ts, "tok-a")

	// tenant-b tries to send input → 403.
	if code := postInput(t, ts, "tok-b", sid, "hi", false); code != http.StatusForbidden {
		t.Fatalf("cross-tenant input status = %d, want 403", code)
	}

	// tenant-b tries to stream events → 403.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp := openEvents(t, ctx, ts, "tok-b", sid)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-tenant events status = %d, want 403", resp.StatusCode)
	}
}

// readUntilQuestion scans SSE data lines until a `question` DTO whose prompt
// contains want, returning that DTO. ok is false if the stream/context ends
// first.
func readUntilQuestion(r io.Reader, want string) (eventDTO, bool) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var dto eventDTO
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &dto); err != nil {
			continue
		}
		if dto.Kind == "question" && strings.Contains(dto.Prompt, want) {
			return dto, true
		}
	}
	return eventDTO{}, false
}

// A pending ask_user question is not persisted to the Store and the hub does not
// buffer, so a question emitted before a connection would be lost on reconnect —
// blocking the tool. A fresh subscriber must have it re-surfaced.
func TestReconnectResurfacesPendingQuestion(t *testing.T) {
	srv, _ := newTestServer(t, map[string]string{"tok-a": "tenant-a"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	sid := createSession(t, ts, "tok-a")

	// Grab the session's asker and register a pending question, as the ask_user
	// tool would. Ask blocks until answered, so run it in a goroutine.
	srv.mu.RLock()
	asker := srv.askers[sid]
	srv.mu.RUnlock()
	if asker == nil {
		t.Fatal("session has no asker")
	}
	answered := make(chan string, 1)
	go func() {
		ans, _ := asker.Ask(context.Background(), tool.AskRequest{
			Prompt:  "which file?",
			Choices: []string{"a.ts", "b.ts"},
		})
		answered <- ans
	}()

	// Wait until the question is registered as pending.
	deadline := time.Now().Add(5 * time.Second)
	for asker.Pending() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("question never became pending")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// A fresh connection (simulating a reload) must re-surface the question.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp := openEvents(t, ctx, ts, "tok-a", sid)
	defer resp.Body.Close()
	dto, ok := readUntilQuestion(resp.Body, "which file?")
	if !ok {
		t.Fatal("reconnect did not re-surface the pending question")
	}
	if dto.ReqID == "" || len(dto.Choices) != 2 {
		t.Fatalf("re-surfaced question missing fields: %+v", dto)
	}
	// The seq must sit in the gap between history and the live range: a value at
	// or above liveSeqBase would advance a downstream monotonic forwarding guard
	// past every future live event and suppress the rest of the stream.
	if dto.Seq < resurfaceSeqBase || dto.Seq >= liveSeqBase {
		t.Fatalf("re-surfaced seq %d outside [%d, %d)", dto.Seq, resurfaceSeqBase, liveSeqBase)
	}

	// Answering via the asker unblocks the tool — proving the re-surfaced reqId
	// still correlates to the live pending question.
	if !asker.Resolve(dto.ReqID, "a.ts") {
		t.Fatalf("resolve of re-surfaced reqId %q failed", dto.ReqID)
	}
	select {
	case ans := <-answered:
		if ans != "a.ts" {
			t.Fatalf("answer = %q, want a.ts", ans)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tool did not unblock after answering re-surfaced question")
	}
}

func TestReconnectReplaysHistory(t *testing.T) {
	srv, _ := newTestServer(t, map[string]string{"tok-a": "tenant-a"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	sid := createSession(t, ts, "tok-a")

	// Drive a turn to completion so history accumulates.
	if code := postInput(t, ts, "tok-a", sid, "hi", false); code != http.StatusAccepted {
		t.Fatalf("input status = %d, want 202", code)
	}

	// Poll the store until the assistant turn lands (the Flight runs async).
	deadline := time.Now().Add(5 * time.Second)
	for {
		recs, err := srv.store.History(context.Background(), store.SessionID(sid))
		if err == nil {
			for _, r := range recs {
				if strings.Contains(r.Text, "hello from fake") {
					goto connected
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("assistant turn never persisted")
		}
		time.Sleep(20 * time.Millisecond)
	}

connected:
	// A fresh (reconnecting) subscriber must see the prior text from history
	// replay even though no new live event is emitted for it.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp := openEvents(t, ctx, ts, "tok-a", sid)
	defer resp.Body.Close()
	if !readUntilText(resp.Body, "hello from fake") {
		t.Fatal("reconnect did not replay history text")
	}
}
