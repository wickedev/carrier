# Design Document

## Overview

Carrier is a Go runtime that drives many concurrent coding-agent sessions on a
server. Each session ("Flight") is one goroutine running a provider-agnostic
agent loop; a dispatcher ("Tower") owns Flight lifecycles and a concurrency cap.
Model calls go through an "Engine" adapter that normalizes Anthropic and OpenAI
into one canonical streaming-event model. Tool execution is confined to an
isolated "Bay" (sandbox). Durable state lives behind a `Store`, so runtime
instances stay stateless and horizontally scalable.

Design rationale and the prior-art it draws on are recorded in
`docs/research/prior-art.md` (architecture) and
`docs/research/primitives-matrix.md` (14-axis primitives). This document turns
those conclusions into concrete Go interfaces, data models, and control flow that
satisfy `requirements.md`.

Guiding principles (from the research):

- **One canonical internal model; adapt providers to it.** Nothing above the
  Engine branches on vendor.
- **Cache-safety is structural.** Messages and tool results are immutable and
  content-addressed; serialization is deterministic so the provider prompt-cache
  hits across turns, forks, and resume.
- **Side-channel the expensive work.** Classification, memory extraction, and
  compaction run on child goroutines, never inline in the turn.
- **Sandbox is a day-one interface.** Tools call an `Executor`, never `os/exec`.
- **Layered, declarative permissions** independent of the sandbox gate.

## Architecture

### Fleet metaphor → package map

```
cmd/carrier/            process entrypoint; wires Tower + Engine + Bay + Store
internal/agent/         canonical types: Message, StreamEvent, ToolCall, Tool, Usage
internal/engine/        Engine interface + Anthropic / OpenAI adapters
internal/flight/        the per-session agent loop (one goroutine)
internal/tower/         dispatcher: concurrency cap, lifecycle, registry
internal/sq/            per-session submission (SQ) + event (EQ) queues, wake, steer/queue
internal/tool/          Tool contract, registry, concurrency partitioning, exposure
internal/bay/           Executor interface + sandbox implementations (local re-exec, …)
internal/perm/          declarative permission rules, sources, classifier hook
internal/store/         Store interface: append-only log + index + replacement records
internal/checkpoint/    workspace snapshots (per-session bare git)
internal/context/       context budget, compaction, frozen replacement
internal/skill/         skill discovery + single gateway tool
internal/mcp/           MCP client (stdio / http / in-process), namespacing
internal/hook/          typed middleware lifecycle hooks
internal/subagent/      child-Flight spawning, fan-out, permission ceiling
internal/obs/           cost accounting, OTel spans, decision-source audit
internal/server/        HTTP + SSE surface, tenant auth, reconnect/dedupe
```

### High-level flow

```
client ──HTTP──▶ server ──▶ Tower.Launch(ctx, Flight, input)
                                  │ acquire slot (semaphore, backpressure)
                                  ▼
                            goroutine: Flight.Run(ctx)
   ┌──────────────────────── loop (per step) ────────────────────────┐
   │ build StepInput from history (Store)                            │
   │ Engine.RunStep(ctx, in) ──stream──▶ StreamEvent…                │
   │   • text/reasoning deltas ──▶ EQ ──▶ server ──SSE──▶ client     │
   │   • tool-call event ──▶ permission gate ──▶ Bay.Exec (sandbox)  │
   │   • tool results ──▶ appended to history (Store, append-only)   │
   │ recovery transitions: context-overflow→compact→retry; idle TO   │
   │ SQ: steer (interrupt) / queue (next cycle); ctx cancel = interrupt│
   └─────────────────────────────────────────────────────────────────┘
                                  │ done → final text
                                  ▼
                            release slot; persist; emit terminal event
```

## Components and Interfaces

### Canonical types (`internal/agent`)

Already seeded by the skeleton; extended with streaming events.

```go
type Role string
const (RoleUser Role = "user"; RoleAssistant Role = "assistant"; RoleTool Role = "tool")

type Message struct { Role Role; Text string; ToolCalls []ToolCall; ToolCallID string }
type ToolCall struct { ID, Name string; Input map[string]any }
type Tool struct { Name, Description string; Schema map[string]any /* + predicates, see tool pkg */ }

type StepInput struct { System string; Messages []Message; Tools []Tool; OnEvent func(StreamEvent) }

// Canonical streaming event — every Engine maps its native stream into this.
type EventKind int
const (
    EvText EventKind = iota; EvReasoning
    EvToolInputDelta; EvToolCall; EvToolResult
    EvStepStart; EvStepFinish; EvUsage; EvError
)
type StreamEvent struct {
    Kind     EventKind
    Text     string        // EvText / EvReasoning delta
    ToolCall *ToolCall      // EvToolCall
    Result   *ToolResult    // EvToolResult
    Usage    *Usage         // EvUsage / EvStepFinish
    Err      *EngineError    // EvError
}

type Usage struct { InputTokens, OutputTokens, CacheReadTokens, CacheWriteTokens, ReasoningTokens int }

type StepResult struct { Text string; ToolCalls []ToolCall; Done bool; Usage Usage }
```

`EngineError` is a typed, classified error (see Error Handling).

### Engine (`internal/engine`) — Req 1

```go
type Engine interface {
    Name() string
    RunStep(ctx context.Context, in agent.StepInput) (agent.StepResult, error)
}
```

- `RunStep` runs exactly one model turn, streaming `StreamEvent`s through
  `in.OnEvent` and returning the aggregated `StepResult`.
- `AnthropicEngine`: system as a top-level param; tools via `input_schema`;
  `tool_use` blocks (parsed input); thinking blocks; `stop_reason` → `Done`.
  Model `claude-opus-4-8`, `max_tokens` required, adaptive thinking, stream large
  outputs.
- `OpenAIEngine`: Chat Completions; system as `messages[0]`; tools as
  `function` defs; `tool_calls[].function.arguments` parsed via `encoding/json`;
  `finish_reason == "tool_calls"` → not done. (Chat Completions chosen over the
  Responses/Agents SDK, which embeds its own loop.)
- Both wrap the official Go SDKs. Normalization (events, usage, error
  classification) lives in the adapter, in one place per provider.

### Session queues (`internal/sq`) — Req 2, 7

```go
type Delivery int
const (Steer Delivery = iota; Queue)

type Input struct { Msg agent.Message; Delivery Delivery }

type Queues struct { /* bounded SQ in, bounded EQ out */ }
func (q *Queues) Submit(in Input) error       // backpressure when SQ full
func (q *Queues) Wake()                         // coalesced wake signal
func (q *Queues) Emit(ev agent.StreamEvent) error // backpressure/shed when EQ full
```

- SQ = bounded inbound channel; EQ = bounded outbound channel.
- `Wake` coalesces redundant signals (a buffered size-1 channel drained
  non-blocking).
- Steer interrupts the active turn (via the turn's `context.CancelFunc`); Queue
  is consumed at the next loop cycle. Turn start does an idempotent idleness
  re-check (select over stream-done and SQ) to avoid the queued-input race.

### Flight loop (`internal/flight`) — Req 3

Existing `Flight.Run` is extended to: stream events to the EQ, dispatch tools
mid-stream through the permission gate and Bay, reload history from the Store
each step, and implement recovery transitions (overflow→compact→retry, idle
timeout). The loop speaks only `agent.*` types.

### Tower (`internal/tower`) — Req 2

Existing dispatcher, extended with a session registry
(`map[SessionID]*Flight` behind a mutex) for the server to observe/drive, plus
graceful shutdown that cancels the Fleet and waits.

### Tool system (`internal/tool`) — Req 4

```go
type Exposure int
const (Direct Exposure = iota; Deferred; ModelOnly; Hidden)

type Tool interface {
    Name() string
    Schema() map[string]any
    IsReadOnly(input map[string]any) bool        // default false
    IsConcurrencySafe(input map[string]any) bool // default false
    Exposure() Exposure
    Exec(ctx context.Context, input map[string]any, ec ExecContext) (Result, error)
}
```

- Registry assembles built-ins + MCP + skill-gateway tools, deduped by name,
  sorted to keep a stable cache prefix.
- Turn-level dispatch partitions calls into consecutive batches: read-only/safe
  batches run via `errgroup` + a semaphore; non-safe calls are serial barriers
  preserving model-intended order.
- `Result` over a size threshold spills to the Store and substitutes a preview.

### Sandbox / Executor (`internal/bay`) — Req 5

```go
type Executor interface {
    Exec(ctx context.Context, spec ExecSpec) (ExecResult, error)
    Close() error
}
type ExecSpec struct {
    Argv       []string
    Cwd        string
    Env        []string
    ReadRoots  []string
    WriteRoots []string
    Network    NetworkPolicy
    MaxOutput  int
    Timeout    time.Duration
}
```

- `LocalReExecExecutor`: confines via an out-of-process re-exec wrapper, using
  the **arg0 self-re-exec** pattern — the Carrier binary re-invokes itself with a
  sentinel `argv[0]`; an early dispatch in `main` detects the sentinel and runs
  the sandbox-helper path instead of normal startup, so no separate helper binary
  ships. Linux: bubblewrap (namespaces + binds) + seccomp/Landlock (network +
  block `ptrace`/`process_vm_*`/`io_uring`). macOS: generated Seatbelt `.sbpl`
  with readable/writable roots as params. Helper path hardcoded and validated.
- Output cap, timeout, and SIGTERM→SIGKILL process-group kill enforced for every
  exec. Sandbox-denial signatures detected and routed to escalation (Req 5.7,
  6.3).
- Future Executors (container, microVM/E2B) implement the same interface.

### Permissions (`internal/perm`) — Req 6

```go
type Effect int
const (Allow Effect = iota; Deny; Ask)
type Rule struct { Action, Pattern string; Effect Effect; Source Source }
type Decision struct { Effect Effect; Reason DecisionReason; Source Source }

type Policy interface { Evaluate(action, resource string) Decision }
```

- Wildcard matching; `findLast` wins; default `ask`. Source precedence
  managed > project > user > session, with managed overriding user.
- Independently gateable categories (sandbox/rules/skill/mcp).
- `ask` blocks the tool goroutine on a reply channel; `always` persists a rule.
- Optional classifier runs **off the main loop** on a sanitized projection;
  consecutive-denial fallback to human approval.
- Independent of the Bay: a confined read can be auto-allowed.

### Store & checkpoint (`internal/store`, `internal/checkpoint`) — Req 8

```go
type Store interface {
    Append(ctx context.Context, sid SessionID, rec Record) error // append-only
    History(ctx context.Context, sid SessionID) ([]Record, error) // replay to last checkpoint
    PutReplacement(ctx context.Context, sid SessionID, r Replacement) error
    Index() Index // listing / resume metadata
}
```

- Append-only JSONL log per session + a SQLite (or Postgres) metadata index.
- Resume replays backward to the most recent compaction checkpoint; replacement
  records reproduce byte-identical previews for cache stability.
- `checkpoint`: per-session bare git repo; commit on tool exec; `Restore(hash)`,
  `Diff(hash)`, `Revert`.
- Instances are stateless; durable state is entirely in the Store.

### Context & compaction (`internal/context`) — Req 9

- Track usage vs usable budget per turn.
- Proactive compaction at a threshold below the hard limit; preserve recent
  turns; carry prior summary forward.
- Frozen replacement: tool results are content-addressed by tool-call ID and
  evicted/tombstoned without busting the cached prefix.
- Checkpoint agent/model/tool/todo config across the compaction boundary and
  restore on continue (prevents post-compaction config reset).

### Extension surface

- **Skills** (`internal/skill`, Req 10): discover packages; surface metadata
  only; a single gateway tool loads a body on demand under permission + per-skill
  restriction.
- **MCP** (`internal/mcp`, Req 11): client over stdio / streamable-HTTP /
  in-process; `mcp__<server>__<tool>` namespacing; per-session connection scoping
  with idle disconnect; OAuth where required; large-output offload.
- **Hooks** (`internal/hook`, Req 12): typed middleware chain (return-new, not
  in-place); pre/post-tool, session start/end, pre/post-compaction; block /
  rewrite-input / append-context outcomes; trust-granting config restricted to
  user/session layers.
- **Subagents** (`internal/subagent`, Req 13): spawn a child Flight goroutine
  with a scoped registry and a derived permission ceiling (inherit deny); bounded
  fan-out (semaphore) and recursion depth; summarized result; optional
  backgrounding with completion notification.
- **Plan & reflection** (Req 14): plan mode = a permission mode + read-only/plan
  tool filter; plan persisted to a file; review = a constrained sub-agent (no
  network, local-only writes, optional cheaper model); exit never restores into
  auto-approval.
- **Memory** (`internal/skill`/`context`, Req 15): walk-up instruction files
  injected outside mutable history with de-dupe; optional off-loop session
  extraction.

### Observability (`internal/obs`) — Req 16

- Per-session cost accounting with cache tokens separated; aggregate per
  session/tenant.
- OTel span tree (session → turn → tool → hook) via `context.Context`
  propagation; hot-path enable guard.
- Each tool decision records its source (user/rule/classifier/hook).

### Server (`internal/server`) — Req 17

- HTTP: create session, send input, stream events (SSE). SSE decoupled from the
  core by reading the Flight's EQ.
- Many-clients-per-session and one-client-many-sessions via a registry with
  per-session fan-out.
- Reconnect: history fetch from the Store + dedupe by event ID.
- Tenant auth; per-tenant session isolation.

## Data Models

- **Record** (append-only log line): `{seq, session_id, kind, role, content|tool_call|tool_result, ts}` — immutable; tool-call/result carry stable IDs.
- **Replacement**: `{tool_call_id, preview, full_ref}` — frozen, content-addressed; reproduced on resume.
- **Rule**: `{action, pattern, effect, source}`.
- **Skill**: `{name, description, body_ref, restrictions}` — metadata surfaced, body lazy.
- **SessionMeta** (index): `{session_id, tenant, status, created_at, last_seq, cost}`.
- **CheckpointRef**: `{session_id, git_hash, ts}`.

## Error Handling

- `EngineError` classifies provider failures into `{RateLimited, ContextOverflow, Retryable, QuotaExceeded, Refusal, Fatal}` with optional `RetryAfter`. The loop branches on the class: `ContextOverflow` → compact+retry; `RateLimited`/`Retryable` → backoff retry honoring `RetryAfter`; `Fatal` → terminate the Flight with a typed error.
- Per-provider/per-model concurrency semaphores throttle outbound calls to avoid 429 storms across many sessions.
- Tool failures become tool results fed back to the model (not Flight aborts).
- Idle-timeout on every streaming receive (context deadline) prevents a stalled stream from pinning a goroutine.
- Sandbox-denial signatures are detected and routed to the approval/escalation flow.
- Outbound EQ is bounded; the overflow policy (block vs shed) is explicit and per-session.

## Testing Strategy

- **Unit:** Engine adapters with recorded/golden provider streams (verify both Anthropic and OpenAI normalize to identical `StreamEvent` sequences); permission rule evaluation/precedence; tool concurrency partitioning; SQ/EQ steer/queue and the idleness re-check race; compaction frozen-replacement reproducibility.
- **Provider-parity:** one suite that runs the same Flight against `AnthropicEngine` and `OpenAIEngine` and asserts identical loop behavior and event shapes.
- **Sandbox:** Executor escape tests (out-of-tree write denied, network denied, blocked syscalls), output-cap and timeout/SIGKILL behavior, PATH-injection resistance; platform-gated (Linux bwrap, macOS Seatbelt).
- **Concurrency:** many concurrent Flights under the cap, backpressure, graceful shutdown, EQ bounding; run with `-race`.
- **Persistence:** append→crash→resume reconstructs identical history and byte-identical previews; backward-replay to checkpoint; workspace snapshot restore/diff.
- **Integration:** server create/send/stream, reconnect with dedupe, multi-client fan-out, tenant isolation.
- All concurrency-touching tests run under the Go race detector in CI.
