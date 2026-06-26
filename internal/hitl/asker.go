package hitl

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wickedev/carrier/internal/tool"
)

// QuestionRequest is a pending user question surfaced to a client (emitted over
// SSE), correlated back to the blocked ask_user tool by ID. Seq is a stable,
// monotonic ordinal: the transport maps it to a fixed event seq so a question
// re-surfaced on reconnect dedupes against the original (client dedups by seq).
type QuestionRequest struct {
	ID      string
	Seq     uint64
	Prompt  string
	Choices []string
}

// pendingQuestion is a question awaiting an answer: the channel the blocked
// Ask() is selecting on, plus the request so it can be re-surfaced to a
// (re)connecting client.
type pendingQuestion struct {
	ch  chan string
	req QuestionRequest
}

// ChannelAsker is a tool.Asker (the string analogue of ChannelApprover):
// onRequest surfaces each question to the transport; Resolve delivers the user's
// answer back to the blocked tool.
type ChannelAsker struct {
	onRequest func(QuestionRequest)
	timeout   time.Duration

	mu      sync.Mutex
	pending map[string]*pendingQuestion
	seq     atomic.Uint64
}

var _ tool.Asker = (*ChannelAsker)(nil)

// NewAsker returns a ChannelAsker. timeout <= 0 waits indefinitely (until
// Resolve or ctx cancel).
func NewAsker(onRequest func(QuestionRequest), timeout time.Duration) *ChannelAsker {
	return &ChannelAsker{
		onRequest: onRequest,
		timeout:   timeout,
		pending:   make(map[string]*pendingQuestion),
	}
}

// Ask implements tool.Asker: register the question, surface it, and block until
// a matching Resolve, the timeout, or ctx cancel.
func (a *ChannelAsker) Ask(ctx context.Context, req tool.AskRequest) (string, error) {
	n := a.seq.Add(1)
	qr := QuestionRequest{
		ID:      fmt.Sprintf("ask-%d", n),
		Seq:     n,
		Prompt:  req.Prompt,
		Choices: req.Choices,
	}
	ch := make(chan string, 1)

	a.mu.Lock()
	a.pending[qr.ID] = &pendingQuestion{ch: ch, req: qr}
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.pending, qr.ID)
		a.mu.Unlock()
	}()

	if a.onRequest != nil {
		a.onRequest(qr)
	}

	var timeout <-chan time.Time
	if a.timeout > 0 {
		t := time.NewTimer(a.timeout)
		defer t.Stop()
		timeout = t.C
	}

	select {
	case ans := <-ch:
		return ans, nil
	case <-timeout:
		return "", fmt.Errorf("question timed out")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Resolve delivers the user's answer to a pending question by ID. It returns
// false if the ID is unknown (already answered, timed out, or cancelled).
func (a *ChannelAsker) Resolve(id, answer string) bool {
	a.mu.Lock()
	pq, ok := a.pending[id]
	a.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case pq.ch <- answer:
		return true
	default:
		return false
	}
}

// Pending reports how many questions are awaiting an answer.
func (a *ChannelAsker) Pending() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.pending)
}

// Snapshot returns the questions currently awaiting an answer, ordered by Seq.
// The transport re-surfaces these to a (re)connecting client so a question
// emitted before the connection — absent from the replayed Store history and
// gone from the live hub — is not lost, which would leave the tool blocked.
func (a *ChannelAsker) Snapshot() []QuestionRequest {
	a.mu.Lock()
	out := make([]QuestionRequest, 0, len(a.pending))
	for _, pq := range a.pending {
		out = append(out, pq.req)
	}
	a.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}
