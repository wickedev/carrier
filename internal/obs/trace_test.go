package obs

import (
	"context"
	"testing"
)

// withEnabled flips the package-level guard for the duration of fn and restores
// it afterward. Tests run serially within a package by default for these.
func withEnabled(v bool, fn func()) {
	prev := Enabled
	Enabled = v
	defer func() { Enabled = prev }()
	fn()
}

func TestRecordingTracer_SpanTree(t *testing.T) {
	withEnabled(true, func() {
		tr := NewRecordingTracer()
		ctx := context.Background()

		ctx, session := tr.StartSpan(ctx, "session")
		session.SetAttr("session.id", "s1")

		turnCtx, turn := tr.StartSpan(ctx, "turn")
		_, tool := tr.StartSpan(turnCtx, "tool")

		// A sibling turn from the original session context.
		_, turn2 := tr.StartSpan(ctx, "turn2")

		tool.End()
		turn.End()
		turn2.End()
		session.End()

		rs, ok := session.(*RecordingSpan)
		if !ok {
			t.Fatalf("session span is %T, want *RecordingSpan", session)
		}
		if rs.Parent != nil {
			t.Fatalf("session.Parent = %v, want nil (root)", rs.Parent)
		}

		// turn and turn2 are children of session.
		children := tr.Children(rs)
		if len(children) != 2 {
			t.Fatalf("session children = %d, want 2", len(children))
		}

		turnRS := turn.(*RecordingSpan)
		if turnRS.Parent != rs {
			t.Fatalf("turn.Parent = %v, want session", turnRS.Parent)
		}

		// tool is a child of turn, not of session.
		toolRS := tool.(*RecordingSpan)
		if toolRS.Parent != turnRS {
			t.Fatalf("tool.Parent = %v, want turn", toolRS.Parent)
		}
		toolChildren := tr.Children(turnRS)
		if len(toolChildren) != 1 || toolChildren[0] != toolRS {
			t.Fatalf("turn children = %v, want [tool]", toolChildren)
		}

		if v, ok := rs.Attr("session.id"); !ok || v != "s1" {
			t.Fatalf("session.id attr = %v, %v; want s1,true", v, ok)
		}
		if !rs.Ended() {
			t.Fatalf("session span not ended")
		}
		if len(tr.Spans()) != 4 {
			t.Fatalf("total spans = %d, want 4", len(tr.Spans()))
		}
	})
}

func TestDisabledTracer_HotPathGuard(t *testing.T) {
	withEnabled(false, func() {
		tr := NewRecordingTracer()
		ctx := context.Background()

		got, span := tr.StartSpan(ctx, "session")

		// Same ctx returned (no WithValue allocation), no recording.
		if got != ctx {
			t.Fatalf("disabled StartSpan returned a new context")
		}
		if SpanFromContext(got) != nil {
			t.Fatalf("disabled StartSpan stored a span in context")
		}
		if span != sharedNoopSpan {
			t.Fatalf("disabled StartSpan did not return the shared no-op span")
		}
		if len(tr.Spans()) != 0 {
			t.Fatalf("disabled tracer recorded %d spans, want 0", len(tr.Spans()))
		}

		// No-op span methods must not panic.
		span.SetAttr("k", "v")
		span.End()
	})
}

func TestNoopTracer(t *testing.T) {
	// NoopTracer is inert regardless of the guard.
	withEnabled(true, func() {
		var tr NoopTracer
		ctx := context.Background()
		got, span := tr.StartSpan(ctx, "x")
		if got != ctx {
			t.Fatalf("NoopTracer returned a new context")
		}
		if span != sharedNoopSpan {
			t.Fatalf("NoopTracer did not return the shared no-op span")
		}
	})
}

func TestStartSpanNoAllocWhenDisabled(t *testing.T) {
	withEnabled(false, func() {
		tr := NewRecordingTracer()
		ctx := context.Background()
		allocs := testing.AllocsPerRun(100, func() {
			c, s := tr.StartSpan(ctx, "hot")
			_ = c
			_ = s
		})
		if allocs != 0 {
			t.Fatalf("disabled StartSpan allocated %v times, want 0", allocs)
		}
	})
}
