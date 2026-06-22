// Package store is the durable, append-only home for session state.
//
// Every Flight's conversation is persisted as an append-only log of Records —
// one record per event — so any stateless runtime instance can recover or
// resume a session purely from the Store (Req 8). A separate metadata Index
// supports listing and resume. History replays the log backward to the most
// recent checkpoint, and Replacements reproduce byte-identical previews so the
// prompt cache stays stable across a resume.
package store

import (
	"context"
	"time"

	"github.com/wickedev/carrier/internal/agent"
)

// SessionID identifies one session (one Flight's durable state).
type SessionID string

// Kind classifies a Record.
type Kind string

const (
	// KindTurn is a normal conversation turn: user text, an assistant turn
	// (text and/or tool calls), or a tool result fed back to the model.
	KindTurn Kind = "turn"

	// KindCheckpoint marks a compaction boundary. History replays backward to
	// the most recent KindCheckpoint record; everything before it is dropped
	// from the reconstructed conversation. A checkpoint record carries the
	// compaction summary in Text.
	KindCheckpoint Kind = "checkpoint"
)

// Record is one immutable, append-only log line.
//
// A Record represents a single conversation turn — a role plus its content,
// which is plain text, a set of tool calls the assistant requested, and/or a
// tool result — together with bookkeeping: a per-session monotonic Seq, a Kind,
// and a creation timestamp. Tool calls and results carry stable IDs so a
// resumed session can re-link them.
type Record struct {
	// Seq is the per-session monotonic sequence number. It is assigned by the
	// Store on Append (callers may leave it zero); the first record in a
	// session is Seq 1.
	Seq int `json:"seq"`

	// SessionID is the owning session. The Store fills it in on Append.
	SessionID SessionID `json:"session_id"`

	// Kind is the record classification (turn vs checkpoint).
	Kind Kind `json:"kind"`

	// Role is who produced this turn.
	Role agent.Role `json:"role"`

	// Text is plain user/assistant content, the tool result on a RoleTool turn,
	// or the compaction summary on a KindCheckpoint record.
	Text string `json:"text,omitempty"`

	// ToolCalls is set on an assistant turn requesting tools.
	ToolCalls []agent.ToolCall `json:"tool_calls,omitempty"`

	// ToolResult is set on a tool turn carrying the outcome of a ToolCall.
	ToolResult *agent.ToolResult `json:"tool_result,omitempty"`

	// CreatedAt is when the record was appended.
	CreatedAt time.Time `json:"created_at"`
}

// Replacement is a frozen, content-addressed preview of a tool result.
//
// Tool results may be large; to keep the prompt cache stable a result is
// replaced in-context by a short Preview plus a FullRef pointing at the full
// content. Replacements must reproduce byte-identically on resume.
type Replacement struct {
	ToolCallID string `json:"tool_call_id"`
	Preview    string `json:"preview"`
	FullRef    string `json:"full_ref"`
}

// Status is a session's lifecycle state in the index.
type Status string

const (
	StatusActive Status = "active"
	StatusDone   Status = "done"
)

// SessionMeta is the index entry for one session: enough to list sessions and
// resume them without reading the full log.
type SessionMeta struct {
	SessionID SessionID `json:"session_id"`
	Status    Status    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	LastSeq   int       `json:"last_seq"`
	Cost      float64   `json:"cost"`
}

// Store is the durable, append-only home for session state.
type Store interface {
	// Append adds a record to the session's log. It is append-only and
	// concurrency-safe; the Store assigns the record's Seq monotonically per
	// session.
	Append(ctx context.Context, sid SessionID, rec Record) error

	// History returns the session's records replayed to the most recent
	// checkpoint: records at or after the last KindCheckpoint marker (the
	// checkpoint itself included), or all records if there is no checkpoint.
	History(ctx context.Context, sid SessionID) ([]Record, error)

	// Messages projects History into the canonical message list the loop
	// consumes.
	Messages(ctx context.Context, sid SessionID) ([]agent.Message, error)

	// PutReplacement persists a frozen replacement for a tool call.
	PutReplacement(ctx context.Context, sid SessionID, r Replacement) error

	// GetReplacement returns the replacement for a tool call, if present.
	GetReplacement(ctx context.Context, sid SessionID, toolCallID string) (Replacement, bool, error)

	// Index returns the metadata index for listing and resume.
	Index() Index
}

// Index is the metadata index over sessions.
type Index interface {
	// List returns metadata for every known session.
	List(ctx context.Context) ([]SessionMeta, error)

	// Get returns the metadata for one session, if present.
	Get(ctx context.Context, sid SessionID) (SessionMeta, bool, error)
}

// projectMessages turns a replayed record slice into canonical messages.
func projectMessages(recs []Record) []agent.Message {
	msgs := make([]agent.Message, 0, len(recs))
	for _, r := range recs {
		switch r.Kind {
		case KindCheckpoint:
			// The checkpoint summary becomes a single assistant context turn so
			// the carried-forward summary survives into the resumed history.
			msgs = append(msgs, agent.Message{
				Role: agent.RoleAssistant,
				Text: r.Text,
			})
		default:
			msg := agent.Message{
				Role:      r.Role,
				Text:      r.Text,
				ToolCalls: r.ToolCalls,
			}
			if r.ToolResult != nil {
				msg.ToolCallID = r.ToolResult.ToolCallID
				if r.Text == "" {
					msg.Text = r.ToolResult.Content
				}
			}
			msgs = append(msgs, msg)
		}
	}
	return msgs
}

// replayToCheckpoint drops every record before the last KindCheckpoint marker.
// The checkpoint record itself is kept (it carries the carried-forward summary).
// With no checkpoint, all records are returned.
func replayToCheckpoint(recs []Record) []Record {
	last := -1
	for i, r := range recs {
		if r.Kind == KindCheckpoint {
			last = i
		}
	}
	if last < 0 {
		return recs
	}
	return recs[last:]
}
