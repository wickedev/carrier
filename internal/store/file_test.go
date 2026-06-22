package store

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"

	"github.com/wickedev/carrier/internal/agent"
)

func newStore(t *testing.T) *FileStore {
	t.Helper()
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	return fs
}

func TestAppendReloadIdentical(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	sid := SessionID("s1")

	recs := []Record{
		{Kind: KindTurn, Role: agent.RoleUser, Text: "hello"},
		{Kind: KindTurn, Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{
			{ID: "tc1", Name: "read", Input: map[string]any{"path": "x.go"}},
		}},
		{Kind: KindTurn, Role: agent.RoleTool, ToolResult: &agent.ToolResult{
			ToolCallID: "tc1", Content: "file body", IsError: false,
		}},
	}

	fs, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	for _, r := range recs {
		if err := fs.Append(ctx, sid, r); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	got, err := fs.History(ctx, sid)
	if err != nil {
		t.Fatalf("History: %v", err)
	}

	// Reopen from disk: a fresh store must reproduce identical records.
	fs2, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got2, err := fs2.History(ctx, sid)
	if err != nil {
		t.Fatalf("History reopen: %v", err)
	}

	if !reflect.DeepEqual(got, got2) {
		t.Fatalf("reload mismatch:\n in-mem: %+v\n on-disk: %+v", got, got2)
	}
	if len(got2) != len(recs) {
		t.Fatalf("want %d records, got %d", len(recs), len(got2))
	}
	for i, r := range got2 {
		if r.Seq != i+1 {
			t.Errorf("record %d: Seq = %d, want %d", i, r.Seq, i+1)
		}
		if r.SessionID != sid {
			t.Errorf("record %d: SessionID = %q, want %q", i, r.SessionID, sid)
		}
		if r.CreatedAt.IsZero() {
			t.Errorf("record %d: CreatedAt is zero", i)
		}
	}
	// Spot-check round-tripped content.
	if got2[1].ToolCalls[0].Input["path"] != "x.go" {
		t.Errorf("tool call input not round-tripped: %+v", got2[1].ToolCalls[0])
	}
	if got2[2].ToolResult == nil || got2[2].ToolResult.Content != "file body" {
		t.Errorf("tool result not round-tripped: %+v", got2[2].ToolResult)
	}
}

func TestHistoryReplaysToCheckpoint(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name     string
		records  []Record
		wantSeqs []int
	}{
		{
			name: "no checkpoint returns all",
			records: []Record{
				{Kind: KindTurn, Role: agent.RoleUser, Text: "a"},
				{Kind: KindTurn, Role: agent.RoleAssistant, Text: "b"},
			},
			wantSeqs: []int{1, 2},
		},
		{
			name: "drops before last checkpoint, keeps checkpoint",
			records: []Record{
				{Kind: KindTurn, Role: agent.RoleUser, Text: "a"},
				{Kind: KindTurn, Role: agent.RoleAssistant, Text: "b"},
				{Kind: KindCheckpoint, Role: agent.RoleAssistant, Text: "summary"},
				{Kind: KindTurn, Role: agent.RoleUser, Text: "c"},
			},
			wantSeqs: []int{3, 4},
		},
		{
			name: "only the most recent checkpoint survives",
			records: []Record{
				{Kind: KindTurn, Role: agent.RoleUser, Text: "a"},
				{Kind: KindCheckpoint, Role: agent.RoleAssistant, Text: "s1"},
				{Kind: KindTurn, Role: agent.RoleUser, Text: "b"},
				{Kind: KindCheckpoint, Role: agent.RoleAssistant, Text: "s2"},
				{Kind: KindTurn, Role: agent.RoleUser, Text: "c"},
			},
			wantSeqs: []int{4, 5},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newStore(t)
			sid := SessionID("s")
			for _, r := range tt.records {
				if err := fs.Append(ctx, sid, r); err != nil {
					t.Fatalf("Append: %v", err)
				}
			}
			got, err := fs.History(ctx, sid)
			if err != nil {
				t.Fatalf("History: %v", err)
			}
			var gotSeqs []int
			for _, r := range got {
				gotSeqs = append(gotSeqs, r.Seq)
			}
			if !reflect.DeepEqual(gotSeqs, tt.wantSeqs) {
				t.Errorf("seqs = %v, want %v", gotSeqs, tt.wantSeqs)
			}
		})
	}
}

func TestMessagesProjection(t *testing.T) {
	ctx := context.Background()
	fs := newStore(t)
	sid := SessionID("s")

	records := []Record{
		{Kind: KindTurn, Role: agent.RoleUser, Text: "do it"},
		{Kind: KindTurn, Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{
			{ID: "tc1", Name: "ls"},
		}},
		{Kind: KindTurn, Role: agent.RoleTool, ToolResult: &agent.ToolResult{
			ToolCallID: "tc1", Content: "a\nb",
		}},
	}
	for _, r := range records {
		if err := fs.Append(ctx, sid, r); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	msgs, err := fs.Messages(ctx, sid)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	want := []agent.Message{
		{Role: agent.RoleUser, Text: "do it"},
		{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{{ID: "tc1", Name: "ls"}}},
		{Role: agent.RoleTool, Text: "a\nb", ToolCallID: "tc1"},
	}
	if !reflect.DeepEqual(msgs, want) {
		t.Fatalf("projection mismatch:\n got: %+v\n want: %+v", msgs, want)
	}
}

func TestMessagesCheckpointBecomesContext(t *testing.T) {
	ctx := context.Background()
	fs := newStore(t)
	sid := SessionID("s")

	for _, r := range []Record{
		{Kind: KindTurn, Role: agent.RoleUser, Text: "old"},
		{Kind: KindCheckpoint, Role: agent.RoleAssistant, Text: "carried summary"},
		{Kind: KindTurn, Role: agent.RoleUser, Text: "new"},
	} {
		if err := fs.Append(ctx, sid, r); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	msgs, err := fs.Messages(ctx, sid)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	want := []agent.Message{
		{Role: agent.RoleAssistant, Text: "carried summary"},
		{Role: agent.RoleUser, Text: "new"},
	}
	if !reflect.DeepEqual(msgs, want) {
		t.Fatalf("checkpoint projection mismatch:\n got: %+v\n want: %+v", msgs, want)
	}
}

func TestReplacementsByteIdentical(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	sid := SessionID("s")

	fs, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	repls := []Replacement{
		{ToolCallID: "tc1", Preview: "first 200 bytes…", FullRef: "blob:abc123"},
		{ToolCallID: "tc2", Preview: "other\nwith\nnewlines", FullRef: "blob:def456"},
	}
	for _, r := range repls {
		if err := fs.PutReplacement(ctx, sid, r); err != nil {
			t.Fatalf("PutReplacement: %v", err)
		}
	}

	// Capture the on-disk bytes, then reopen and confirm a re-put of the same
	// data produces byte-identical content.
	path := fs.replPath(sid)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read repl file: %v", err)
	}

	fs2, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	for _, want := range repls {
		got, ok, err := fs2.GetReplacement(ctx, sid, want.ToolCallID)
		if err != nil {
			t.Fatalf("GetReplacement: %v", err)
		}
		if !ok {
			t.Fatalf("replacement %q missing after reload", want.ToolCallID)
		}
		if got != want {
			t.Errorf("replacement %q = %+v, want %+v", want.ToolCallID, got, want)
		}
	}

	// Re-writing identical data yields identical bytes (deterministic encoding).
	for _, r := range repls {
		if err := fs2.PutReplacement(ctx, sid, r); err != nil {
			t.Fatalf("re-PutReplacement: %v", err)
		}
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read repl file after: %v", err)
	}
	if string(before) != string(after) {
		t.Fatalf("replacement bytes not stable:\n before: %q\n after:  %q", before, after)
	}

	// Missing ID reports not found, no error.
	if _, ok, err := fs2.GetReplacement(ctx, sid, "nope"); err != nil || ok {
		t.Errorf("GetReplacement(missing) = ok=%v err=%v, want false,nil", ok, err)
	}
}

func TestConcurrentAppendsMonotonicLossless(t *testing.T) {
	ctx := context.Background()
	fs := newStore(t)
	sid := SessionID("s")

	const goroutines = 16
	const perG = 50
	const total = goroutines * perG

	var wg sync.WaitGroup
	errs := make(chan error, total)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				rec := Record{
					Kind: KindTurn,
					Role: agent.RoleUser,
					Text: "x",
				}
				if err := fs.Append(ctx, sid, rec); err != nil {
					errs <- err
					return
				}
			}
		}(g)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Append: %v", err)
	}

	recs, err := fs.History(ctx, sid)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(recs) != total {
		t.Fatalf("lossy: got %d records, want %d", len(recs), total)
	}

	seqs := make([]int, len(recs))
	for i, r := range recs {
		seqs[i] = r.Seq
	}
	sort.Ints(seqs)
	for i, s := range seqs {
		if s != i+1 {
			t.Fatalf("non-monotonic seqs: position %d has Seq %d", i, s)
		}
	}

	// Index reflects the final state.
	meta, ok, err := fs.Index().Get(ctx, sid)
	if err != nil || !ok {
		t.Fatalf("Index.Get: ok=%v err=%v", ok, err)
	}
	if meta.LastSeq != total {
		t.Errorf("Index LastSeq = %d, want %d", meta.LastSeq, total)
	}
}

func TestIndexListAndGet(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	fs, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	for _, sid := range []SessionID{"a", "b", "c"} {
		if err := fs.Append(ctx, sid, Record{Kind: KindTurn, Role: agent.RoleUser, Text: "hi"}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	// Index persists and reloads.
	fs2, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	list, err := fs2.Index().List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("List len = %d, want 3", len(list))
	}
	for _, m := range list {
		if m.Status != StatusActive {
			t.Errorf("%q status = %q, want active", m.SessionID, m.Status)
		}
		if m.LastSeq != 1 {
			t.Errorf("%q LastSeq = %d, want 1", m.SessionID, m.LastSeq)
		}
		if m.CreatedAt.IsZero() {
			t.Errorf("%q CreatedAt is zero", m.SessionID)
		}
	}

	if _, ok, _ := fs2.Index().Get(ctx, "a"); !ok {
		t.Error("Get(a) not found")
	}
	if _, ok, _ := fs2.Index().Get(ctx, "missing"); ok {
		t.Error("Get(missing) found")
	}
}

func TestAppendEmptySessionID(t *testing.T) {
	fs := newStore(t)
	if err := fs.Append(context.Background(), "", Record{}); err == nil {
		t.Fatal("Append with empty sid should error")
	}
}

func TestSeqContinuesAcrossReopen(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	sid := SessionID("s")

	fs, _ := NewFileStore(dir)
	for i := 0; i < 3; i++ {
		if err := fs.Append(ctx, sid, Record{Kind: KindTurn, Text: "x"}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	fs2, _ := NewFileStore(dir)
	if err := fs2.Append(ctx, sid, Record{Kind: KindTurn, Text: "y"}); err != nil {
		t.Fatalf("Append after reopen: %v", err)
	}
	recs, _ := fs2.History(ctx, sid)
	if recs[len(recs)-1].Seq != 4 {
		t.Fatalf("Seq did not continue across reopen: got %d, want 4", recs[len(recs)-1].Seq)
	}

	// Sanity: log file exists where expected.
	if _, err := os.Stat(filepath.Join(dir, "sessions", "s", "log.jsonl")); err != nil {
		t.Fatalf("log file missing: %v", err)
	}
}
