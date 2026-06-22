# Implementation Plan

Incremental, test-driven coding tasks that build Carrier from the current
skeleton. Each task references the requirements it satisfies (see
`requirements.md`). Tasks are ordered so each builds on the previous; the four
phases mirror the roadmap in `docs/research/primitives-matrix.md`.

Only the runtime core is in scope here; deployment/infra is out of scope.

## Phase 1 — Core loop foundation

- [x] 1. Canonical streaming-event model
  - Add `StreamEvent`, `EventKind`, and extend `Usage` (cache-read/write/reasoning) in `internal/agent`.
  - Add `OnEvent func(StreamEvent)` to `StepInput`; keep `StepResult` as the aggregated turn outcome.
  - Add a typed `EngineError` with classes `{RateLimited, ContextOverflow, Retryable, QuotaExceeded, Refusal, Fatal}` and optional `RetryAfter`.
  - Unit-test event construction and error classification.
  - _Requirements: 1.1, 1.2, 1.5, 1.6_

- [x] 2. Append-only Store + replacement records
  - [ ] 2.1 Define the `Store` interface (`Append`, `History`, `PutReplacement`, `Index`) and `Record`/`Replacement`/`SessionMeta` models in `internal/store`.
    - _Requirements: 8.1, 8.2, 8.4, 8.6_
  - [ ] 2.2 Implement a JSONL append-only log store with a SQLite metadata index; reconstruct history by backward-replay to the last checkpoint.
    - Test append→reload reproduces identical records and byte-identical previews.
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 3. Session queues (SQ/EQ) and wake
  - Implement `internal/sq`: bounded SQ inbound, bounded EQ outbound, coalesced `Wake`, `Submit` with backpressure, `Emit` with bounded overflow policy.
  - Implement steer-vs-queue `Input` and the idempotent idleness re-check helper.
  - Race-test concurrent Submit/Emit/Wake and the queued-input-between-idle-and-start race.
  - _Requirements: 2.5, 2.6, 7.1, 7.4_

- [x] 4. Tower: registry, concurrency cap, shutdown
  - Extend `internal/tower` with a `map[SessionID]*Flight` registry behind a mutex, graceful shutdown (cancel Fleet + wait), and slot acquisition with backpressure and ctx-cancel-while-waiting.
  - Race-test many concurrent Launches under the cap and graceful shutdown.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 2.8_

- [x] 5. Flight loop wired to events, store, and SQ/EQ
  - Extend `internal/flight` to stream `StreamEvent`s to the EQ, reload history from the Store each step, enforce the step budget, and feed tool errors back as tool results.
  - Add recovery transitions: idle-timeout per streaming receive (context deadline); `ContextOverflow` → compact-hook → retry placeholder.
  - Add steer (interrupt active turn via `context.CancelFunc`) and queue consumption at cycle boundaries.
  - Test loop termination, step-budget exhaustion, tool-error feedback, idle-timeout, and steer/interrupt.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 7.2, 7.3_

## Phase 2 — Engines (provider adapters)

- [x] 6. Anthropic engine
  - Implement `AnthropicEngine.RunStep` on the official Go SDK: system as top-level param, tools via `input_schema`, stream mapping (`tool_use` parsed input, thinking, text) → `StreamEvent`, `stop_reason` → `Done`, usage normalization.
  - Model `claude-opus-4-8`, `max_tokens` required, adaptive thinking, stream large outputs.
  - Golden-stream unit tests for the event/usage/stop-reason mapping.
  - _Requirements: 1.2, 1.3, 1.5, 3.1_

- [x] 7. OpenAI engine
  - Implement `OpenAIEngine.RunStep` on Chat Completions: system as `messages[0]`, tools as function defs, parse `tool_calls[].function.arguments` via `encoding/json`, `finish_reason` → `Done`, usage normalization.
  - Golden-stream unit tests.
  - _Requirements: 1.2, 1.4, 1.5, 3.1_

- [x] 8. Provider-parity suite + per-provider concurrency throttle
  - Add a test that runs the same Flight against both engines and asserts identical loop behavior and `StreamEvent` shapes.
  - Add per-provider/per-model `x/sync/semaphore` throttling and `RetryAfter`-honoring backoff for `RateLimited`/`Retryable`.
  - _Requirements: 1.6, 1.7_

## Phase 3 — Tools, permissions, sandbox

- [x] 9. Tool contract, registry, concurrency partitioning
  - [x] 9.1 Define the `Tool` interface (schema, `IsReadOnly`, `IsConcurrencySafe`, `Exposure`, `Exec`) with fail-closed defaults in `internal/tool`.
    - _Requirements: 4.1, 4.2, 4.6_
  - [x] 9.2 Implement the registry (built-ins, dedupe by name, stable sort for cache prefix) and the turn-level concurrency partitioner (`errgroup` + semaphore for read batches, serial barriers for writes); one result per call by ID.
    - Test parallel read batches, serial write barriers, and ordering preservation.
    - _Requirements: 4.3, 4.4_
  - [x] 9.3 Implement result spill-to-store with bounded preview substitution above a size threshold.
    - _Requirements: 4.5_

- [ ] 10. Executor / sandbox
  - [x] 10.1 Define the `Executor` interface and `ExecSpec`/`ExecResult` in `internal/bay`; route all tool command execution through it.
    - _Requirements: 5.1_
  - [ ] 10.2 Implement `LocalReExecExecutor` with the arg0 self-re-exec dispatch in `cmd/carrier` (sentinel `argv[0]` → sandbox-helper path); hardcode and validate the helper path.
    - _Requirements: 5.2, 5.5_
  - [ ] 10.3 Linux confinement: bubblewrap FS/namespaces + seccomp/Landlock for network and blocked syscalls (`ptrace`, `process_vm_*`, `io_uring`).
    - _Requirements: 5.3_
  - [x] 10.4 macOS confinement: generated Seatbelt `.sbpl` with readable/writable roots as params.
    - _Requirements: 5.4_
  - [x] 10.5 Enforce output cap, timeout, and SIGTERM→SIGKILL process-group kill; detect sandbox-denial signatures and surface them for escalation.
    - Platform-gated escape tests: out-of-tree write denied, network denied, blocked syscalls, PATH-injection resistance, output-cap, timeout.
    - _Requirements: 5.6, 5.7_

- [x] 11. Permissions & approval
  - [x] 11.1 Implement `internal/perm`: `{action, pattern, effect}` rules, wildcard matching, `findLast` wins, default `ask`, source precedence (managed > project > user > session).
    - Test precedence and wildcard matching.
    - _Requirements: 6.1, 6.2_
  - [x] 11.2 Wire the permission gate into tool dispatch: `ask` blocks the tool on a reply channel; `always` persists a rule; categories independently gateable; independent of the Bay (confined reads auto-allowed).
    - _Requirements: 6.3, 6.4, 6.7_
  - [x] 11.3 Off-loop classifier: run on a sanitized input projection via a child goroutine; consecutive-denial fallback to human approval; record decision source.
    - _Requirements: 6.5, 6.6, 16.4_

- [x] 12. Human-in-the-loop approval round-trip
  - Implement a transport-agnostic `control_request`/`control_response` keyed by request ID, plumbed from the permission gate to the EQ and back via the SQ.
  - Enforce a blocked-on-human timeout policy.
  - _Requirements: 7.5, 7.6_

## Phase 4 — Context, checkpoint, extension surface

- [x] 13. Context budget & compaction
  - Track per-turn usage vs usable budget; proactive compaction at a sub-limit threshold; preserve recent turns + carry summary forward.
  - Frozen, content-addressed (by tool-call ID) replacement that evicts stale tool results without busting the cached prefix; checkpoint+restore agent/model/tool/todo config across the boundary.
  - Test reproducible frozen replacement across resume and config restore after compaction.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 14. Workspace checkpointing
  - Implement `internal/checkpoint`: per-session bare git repo, commit on tool exec, `Restore(hash)`, structured `Diff(hash)`, `Revert`.
  - _Requirements: 8.5_

- [x] 15. Skills
  - Discover skill packages (metadata + body) across scopes; surface metadata only; single gateway tool loads a body on demand under permission + per-skill agent/tool restriction.
  - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [x] 16. MCP client
  - Implement `internal/mcp`: client over stdio, streamable-HTTP, and in-process transports; `mcp__<server>__<tool>` namespacing into the registry; per-session connection scoping with idle disconnect; OAuth where required; large-output offload.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 17. Hooks (typed middleware)
  - Implement `internal/hook`: typed lifecycle hooks (pre/post-tool, session start/end, pre/post-compaction) as a return-new middleware chain; block / rewrite-input / append-context outcomes; restrict trust-granting config to user/session layers.
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [x] 18. Subagents & fan-out
  - Implement `internal/subagent`: spawn a child Flight goroutine with a scoped registry and a derived permission ceiling (inherit deny); bounded fan-out (semaphore) and recursion depth; summarized result; optional backgrounding with completion notification.
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

- [x] 19. Plan mode & constrained review
  - Plan mode = a permission mode + read-only/plan tool filter; persist the plan to a file; exit never restores into auto-approval (escalation circuit-breaker).
  - Review sub-agent = a constrained sub-conversation (no network, local-only writes, optional cheaper model).
  - _Requirements: 14.1, 14.2, 14.3, 14.4_

- [x] 20. Long-term memory
  - Walk-up instruction-file (AGENTS.md/CLAUDE.md) discovery + injection outside mutable history, with per-session de-dupe; optional off-loop session extraction (forked sub-agent on a token/turn threshold).
  - _Requirements: 15.1, 15.2, 15.3, 15.4_

## Phase 5 — Server & observability

- [x] 21. Observability: cost, spans, decision audit
  - Per-session cost accounting (cache tokens separated), aggregated per session/tenant; OTel span tree (session → turn → tool → hook) via `context.Context` with a hot-path enable guard; record decision source per tool call.
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

- [x] 22. HTTP + SSE server surface
  - [x] 22.1 HTTP endpoints to create a session, send input, and stream events (SSE) by reading the Flight's EQ; decouple transport from core via the channel boundary.
    - _Requirements: 17.1, 17.2_
  - [x] 22.2 Many-clients-per-session and one-client-many-sessions via the Tower registry with per-session fan-out.
    - _Requirements: 17.3_
  - [x] 22.3 Reconnect: history fetch from the Store + dedupe by event ID; no event loss across reconnect.
    - _Requirements: 17.4_
  - [x] 22.4 Tenant authentication and per-tenant session isolation.
    - _Requirements: 17.5_

- [ ] 23. End-to-end integration & race-gated CI
  - Integration tests: create/send/stream, reconnect-with-dedupe, multi-client fan-out, tenant isolation; many concurrent Flights under the cap.
  - Run all concurrency-touching tests under `-race` in CI.
  - _Requirements: 2.1, 2.2, 17.1, 17.3, 17.4_
