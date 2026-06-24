package server

import (
	"sync"

	"github.com/wickedev/carrier/internal/agent"
)

// liveSeqBase offsets every live event's seq into a high range so it can never
// collide with a replayed history record's (store) seq, which is a small append
// index. A session would need 2^32 persisted records to reach this — never. The
// value stays well within JS's safe-integer range so the web client parses it
// losslessly.
const liveSeqBase = 1 << 32

// hub is the per-session fan-out. One goroutine drains the Flight's single event
// channel (its EQ) and broadcasts each event to every subscriber. Many
// subscribers may observe one session (Req 17.3); a slow subscriber is lagged
// (its event dropped) rather than allowed to block the drain or the other
// subscribers.
//
// The hub stamps each live event with a per-session, lifetime-monotonic seq
// (liveSeqBase + a counter) at the single drain point, so every connection sees
// the SAME seq for a given live event and the sequence keeps climbing across
// reconnects — a seq-deduping client never collides a fresh live event with one
// it already saw. The hub lives for the whole session, so the counter persists.
type hub struct {
	mu      sync.Mutex
	subs    map[*subscriber]struct{}
	closed  bool
	liveSeq int // next live seq is liveSeqBase + (++liveSeq)
}

// liveEvent is a StreamEvent stamped with its per-session live seq.
type liveEvent struct {
	seq int
	ev  agent.StreamEvent
}

// subscriber is one SSE client's view of a session's event stream.
type subscriber struct {
	ch chan liveEvent
}

const subscriberBuffer = 256

func newHub() *hub {
	return &hub{subs: make(map[*subscriber]struct{})}
}

// run drains the Flight's event channel and fans out until the channel closes
// (the Flight ended), then closes every subscriber so streaming handlers return.
func (h *hub) run(events <-chan agent.StreamEvent) {
	for ev := range events {
		h.broadcast(ev)
	}
	h.close()
}

// broadcast stamps ev with the next per-session live seq and delivers it to every
// subscriber, dropping it for any subscriber whose buffer is full (lag the slow
// client; never block the drain). The seq is assigned once here so all
// subscribers agree and the sequence is monotonic for the session's lifetime.
func (h *hub) broadcast(ev agent.StreamEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.liveSeq++
	le := liveEvent{seq: liveSeqBase + h.liveSeq, ev: ev}
	for sub := range h.subs {
		select {
		case sub.ch <- le:
		default:
			// Subscriber is lagging; drop this event for it rather than blocking.
			// The client can recover missed events by reconnecting (history replay).
		}
	}
}

// subscribe registers a new subscriber and returns it. If the hub has already
// closed (Flight ended), the returned subscriber's channel is already closed so
// the caller's stream loop exits promptly after replaying history.
func (h *hub) subscribe() *subscriber {
	sub := &subscriber{ch: make(chan liveEvent, subscriberBuffer)}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		close(sub.ch)
		return sub
	}
	h.subs[sub] = struct{}{}
	return sub
}

// unsubscribe removes a subscriber on client disconnect. It is idempotent and
// safe to call after the hub has closed.
func (h *hub) unsubscribe(sub *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[sub]; !ok {
		return // already removed (or never added because the hub was closed)
	}
	delete(h.subs, sub)
	close(sub.ch)
}

// close marks the hub closed and closes every remaining subscriber channel so
// streaming handlers return when the Flight ends.
func (h *hub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for sub := range h.subs {
		close(sub.ch)
		delete(h.subs, sub)
	}
}
