package obs

import (
	"context"
	"sync"
)

// Span is a single node in a trace. End closes the span; SetAttr attaches a
// key/value pair. The interface is intentionally minimal so an OpenTelemetry
// span can satisfy it later.
type Span interface {
	End()
	SetAttr(k string, v any)
}

// Tracer starts spans. StartSpan returns a child context carrying the new span
// so that descendants started from that context become its children, forming
// the session → turn → tool → hook hierarchy (Req 16.3).
type Tracer interface {
	StartSpan(ctx context.Context, name string) (context.Context, Span)
}

// spanKey is the unexported context key under which the active span is stored.
type spanKey struct{}

// SpanFromContext returns the active span carried by ctx, or nil if none.
func SpanFromContext(ctx context.Context) Span {
	s, _ := ctx.Value(spanKey{}).(Span)
	return s
}

// Enabled is the package-level hot-path guard. When false, StartSpan on a
// guarded tracer returns the unchanged context and a shared no-op span,
// performing no allocation or string formatting (Req 16.5).
//
// It is an atomic-free plain bool: callers flip it once at startup before
// spans are created. For dynamic toggling under load, wrap reads/writes in
// your own synchronization.
var Enabled = false

// noopSpan is the zero-cost span used when tracing is disabled.
type noopSpan struct{}

func (noopSpan) End()                {}
func (noopSpan) SetAttr(string, any) {}

// sharedNoopSpan is returned for every disabled-path StartSpan so no allocation
// occurs on the hot path.
var sharedNoopSpan Span = noopSpan{}

// NoopTracer discards all spans. StartSpan always returns the input context
// unchanged and the shared no-op span — even when Enabled is true — making it
// the safe default tracer.
type NoopTracer struct{}

// StartSpan implements Tracer.
func (NoopTracer) StartSpan(ctx context.Context, _ string) (context.Context, Span) {
	return ctx, sharedNoopSpan
}

// RecordingSpan is an in-memory span produced by RecordingTracer, used in
// tests to assert the span tree.
type RecordingSpan struct {
	tracer *RecordingTracer

	Name   string
	Parent *RecordingSpan

	mu    sync.Mutex
	attrs map[string]any
	ended bool
}

// End marks the span finished. Idempotent.
func (s *RecordingSpan) End() {
	s.mu.Lock()
	s.ended = true
	s.mu.Unlock()
}

// SetAttr records an attribute on the span.
func (s *RecordingSpan) SetAttr(k string, v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attrs == nil {
		s.attrs = make(map[string]any)
	}
	s.attrs[k] = v
}

// Ended reports whether End has been called.
func (s *RecordingSpan) Ended() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ended
}

// Attr returns a recorded attribute and whether it was set.
func (s *RecordingSpan) Attr(k string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.attrs[k]
	return v, ok
}

// RecordingTracer is an in-memory Tracer for tests. It honors the Enabled
// guard: when Enabled is false it behaves like NoopTracer and records nothing.
// It is safe for concurrent use.
type RecordingTracer struct {
	mu    sync.Mutex
	spans []*RecordingSpan
}

// NewRecordingTracer returns an empty recording tracer.
func NewRecordingTracer() *RecordingTracer { return &RecordingTracer{} }

// StartSpan implements Tracer. When tracing is enabled it creates a recording
// span whose parent is the active span in ctx (if it belongs to this tracer),
// stores it in the returned context, and registers it for later inspection.
func (t *RecordingTracer) StartSpan(ctx context.Context, name string) (context.Context, Span) {
	if !Enabled {
		return ctx, sharedNoopSpan
	}

	var parent *RecordingSpan
	if p, ok := SpanFromContext(ctx).(*RecordingSpan); ok {
		parent = p
	}

	s := &RecordingSpan{tracer: t, Name: name, Parent: parent}

	t.mu.Lock()
	t.spans = append(t.spans, s)
	t.mu.Unlock()

	return context.WithValue(ctx, spanKey{}, s), s
}

// Spans returns a snapshot of all spans created so far, in creation order.
func (t *RecordingTracer) Spans() []*RecordingSpan {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]*RecordingSpan, len(t.spans))
	copy(out, t.spans)
	return out
}

// Children returns the spans whose Parent is the given span, in creation order.
func (t *RecordingTracer) Children(parent *RecordingSpan) []*RecordingSpan {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []*RecordingSpan
	for _, s := range t.spans {
		if s.Parent == parent {
			out = append(out, s)
		}
	}
	return out
}
