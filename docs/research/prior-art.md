# Prior Art: Coding-Agent Runtimes

A comparative analysis of four existing coding-agent codebases, read to extract
architectural lessons for **Carrier** — a server-side, large-scale,
provider-agnostic coding-agent runtime in Go (one goroutine per session, built
on the raw Anthropic/OpenAI SDKs, with tool execution in isolated sandboxes).

This document records what each project does, where they converge (strong
signals worth adopting), where they diverge (notably sandboxing), and the
concrete design implications for Carrier mapped onto Go primitives.

> **See also** [`primitives-matrix.md`](./primitives-matrix.md) — a companion
> 14-axis inventory of agent-harness primitives (tools, MCP, skills, hooks,
> memory, permissions, …) across the same four codebases, with a best-in-class
> reference per axis and a primitive build-order for Carrier.

## Sources

| Project | Language | Identity | Reference value |
| --- | --- | --- | --- |
| [opencode](https://github.com/anomalyco/opencode) | TypeScript (Effect) | Multi-session server with a hand-rolled, SDK-free provider abstraction | High — provider normalization, per-session coordinator, event sourcing |
| [codex](https://github.com/openai/codex) | Rust (~80 crates) | CLI + multiplexing daemon (`app-server`) | High — sandboxing, stream-interleaved tool exec, SQ/EQ session model |
| claude-code 2.1.88 | TypeScript (React/Ink) | Single CLI that can also drive a server-side session | High — tool-concurrency safety model, sandbox/permission split, subagents |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | TypeScript (Bun) | Distribution/orchestration layer **on top of** opencode | Low for the core — the loop is outsourced; useful for capability normalization, error classification, concurrency slots |

> **Key framing:** oh-my-openagent delegates the agent loop, provider protocol,
> and session server to upstream opencode — it is a driver, not a runtime.
> Carrier wants the opposite: the loop *is* the product. The other three are the
> core references.

## Dimension-by-dimension comparison

| Dimension | opencode | codex | claude-code | Implication for Carrier |
| --- | --- | --- | --- | --- |
| **Normalized event type** | Single `LLMEvent` union | Single `ResponseEvent` enum | Stream-event demux into one assistant message | One internal event type; every provider maps into it |
| **Internal wire format** | Both providers normalized | **Collapsed to Responses API** (Chat path deleted) | Anthropic SDK only (4 clouds) | One canonical model + thin per-provider adapters |
| **Session concurrency** | One serialized drain per session (coalesced wake) | **One tokio task per session**, SQ/EQ queues | Subagents as nested loops | Goroutine-per-session is validated |
| **Tool execution** | FiberSet, concurrent | Fired mid-stream, RwLock gate | `IsConcurrencySafe` batching (parallel reads / serial writes) | Metadata-driven parallel/serial barriers |
| **Sandbox** | None (host `spawn`) | **Out-of-process re-exec wrapper** (Seatbelt / bwrap+seccomp) | OS-native (Seatbelt / bwrap), separate from permissions | Adopt the Codex model; transfers to Go |
| **Permissions** | `{action, resource, effect}` wildcard, default `ask` | Approval + sandbox-denial retry/escalation | Declarative rules + fast-model classifier | Declarative allow/deny/ask, independent of sandbox |
| **Persistence** | SQLite event-sourcing; history reloaded from DB each turn | JSONL rollout + SQLite index | Per-session JSONL keyed by message UUID | Append-only log + index; store behind an interface |
| **Streaming transport** | PubSub bus → HTTP SSE | SSE/WS → mpsc → JSON-RPC notifications | Async generators end-to-end | Typed event bus, bounded per-session fan-out |

## Convergent patterns (strong signals)

When three or more of these projects independently agree, treat it as a default
for Carrier.

### 1. A single canonical streaming-event type

Both opencode (`LLMEvent`, `packages/llm/schema/events.ts`) and codex
(`ResponseEvent`, `codex-rs/codex-api/src/common.rs`) funnel every provider's
native stream into one internal union. The loop, persistence, and client
streaming never branch on provider.

→ Carrier: extend the existing `Engine` seam with a canonical
`agent.StreamEvent` (text / reasoning / tool-input / tool-call / tool-result /
step / usage / error deltas). Normalize token-usage accounting in the same place.

### 2. One internal wire format; adapt providers to it

Codex standardized entirely on the OpenAI Responses API and **deleted** the Chat
Completions branch (`model-provider-info/src/lib.rs:50`, `client.rs:1644`),
removing all per-provider message/tool transforms. opencode reconciles Anthropic
content-blocks vs OpenAI `tool_calls`/`reasoning_content` in one protocol layer
per provider.

→ Carrier: pick one canonical internal item/event model and write thin adapters
per provider, rather than carrying two parallel code paths through the loop.

### 3. One serialized loop per session, with coalesced wake + steer/queue input

- codex: one tokio task per session running a FIFO `submission_loop`; bounded
  submission queue (cap 512) + unbounded event queue (`core/src/session/session.rs:26`).
- opencode: `session/run-coordinator.ts` — one active drain per session,
  `wake()` coalesces redundant signals, `interrupt()` cancels and awaits cleanup.
  Mid-run input is first-class: `"steer"` (interrupt) vs `"queue"` (next cycle).

→ Carrier: goroutine-per-session is the right model. Add a bounded inbound
channel (backpressure), a coalescing wake channel, steer/queue input semantics,
and `context.CancelFunc` for interrupt.

### 4. Stream-interleaved tool dispatch + concurrency-safe partitioning

- codex fires each tool the instant its call-item completes mid-stream, collects
  results in a `FuturesOrdered`, and gates parallelism with an `RwLock`
  (read = parallel-safe, write = exclusive) — `core/src/session/turn.rs:1905`,
  `tools/parallel.rs:82`.
- claude-code partitions a turn's tool calls into consecutive batches by
  `IsConcurrencySafe`: read-only batches run in a bounded pool (default 10),
  writes run serially as barriers; a `StreamingToolExecutor` starts tools as they
  stream in — `services/tools/toolOrchestration.ts:91`.

→ Carrier: each tool declares `IsConcurrencySafe`/`IsReadOnly`. Run read batches
in parallel via `errgroup` + a semaphore; treat writes as serial barriers that
preserve model-intended ordering. Fire tools as they parse from the stream.
**Fail closed** — default unsafe.

### 5. The loop owns recovery, not just orchestration

All three bake context-overflow → compaction → retry, idle-stream watchdogs, and
max-token escalation directly into the loop:

- opencode: defect-based `TurnTransitionError` state machine triggers
  auto-compaction retry (`runner/llm.ts:143`).
- claude-code: 413/prompt-too-long → reactive compaction; 90s idle-stream
  watchdog; max-output escalation to 64k (`query.ts:1062`).
- codex: auto-compaction mid-turn at the token limit; a 300s idle timeout wraps
  every streaming `recv` (`turn.rs:353`).

→ Carrier: make overflow→compact→retry and idle-timeout (context-cancel a stalled
provider stream) first-class transitions in the turn state machine.

### 6. Append-only event log + index; store behind an interface

- opencode: event-sourced over SQLite (WAL) at `~/.opencode/opencode.db`;
  history is **reloaded from the store each turn** rather than held in memory.
- codex: JSONL rollout (`rollout/src/recorder.rs:76`) + SQLite state index
  (`state_db.rs`); resume/fork by truncation; pluggable `ThreadStore` trait.
- claude-code: per-session JSONL keyed by message UUID; resume merges by UUID.

→ Carrier: append events as they happen (one writer per session), index metadata
separately (SQLite/Postgres), and define the store as an interface from day one.
Reloading history from the store each turn gives crash-safe resume for a
many-goroutine server.

## The decisive divergence: sandboxing

This is where the projects split, and it is Carrier's differentiator.

- **codex — the reference implementation.** No in-process isolation; the command
  is **re-exec'd through a wrapper binary**:
  - macOS (Seatbelt): `/usr/bin/sandbox-exec -p <sbpl> -D PARAM=value -- <cmd>`,
    with a generated `.sbpl` policy starting `(deny default)` and readable/writable
    roots passed as `-D` params (`sandboxing/src/seatbelt.rs:739`). The binary path
    is hardcoded to defeat PATH injection.
  - Linux (two-stage helper `codex-linux-sandbox`): **bubblewrap** for the
    filesystem (user/pid namespaces, bind mounts, `--unshare-net` when network is
    denied — `linux-sandbox/src/bwrap.rs:234`), then a **seccomp** filter applied
    in-process after `prctl(PR_SET_NO_NEW_PRIVS)` for network/hardening
    (`linux-sandbox/src/landlock.rs:42`). `ptrace`, `process_vm_readv/writev`, and
    `io_uring_*` are unconditionally blocked.
  - The two-stage split (bwrap for FS, seccomp for network) and the
    out-of-process re-exec are **language-agnostic** and transfer directly to Go.
- **claude-code** uses the same family of mechanisms via
  `@anthropic-ai/sandbox-runtime` (Seatbelt / bwrap), and crucially treats the
  **sandbox and the permission system as two independent gates**: confinement
  decides *what a tool can touch*; permission rules decide *whether to run it*.
  Being sandboxed *relaxes* permission prompting (`utils/sandbox/sandbox-adapter.ts`,
  `shouldUseSandbox.ts:130`).
- **opencode and oh-my-openagent have no real isolation** — raw host
  `child_process` with only command block-lists, path-containment, and timeouts
  (`opencode … tool/bash.ts:159`). Both flag the multi-node/remote-execution story
  as unfinished TODOs. **Do not copy this.**

→ Carrier: define an `Executor` interface (local / container / microVM)
**before** building tools, so tools call the executor rather than `os/exec`
directly. Adopt the out-of-process helper re-exec model. Keep the cheap
guardrails (output-size caps, timeout-with-hard-kill SIGTERM→SIGKILL,
process-group kill, working-dir containment) as table stakes *inside* the
sandbox. Hardcode and validate the helper-binary path.

## What not to copy

- **Outsourcing the loop** (oh-my-openagent). The loop, provider protocol, and
  session server all live upstream; it is a driver. Carrier owns all three.
- **No-isolation execution** (opencode, oh-my). Block-lists are bypassable and do
  not scale; they are defense-in-depth, never the primary boundary.
- **Unbounded outbound event queue** (codex). A slow/stalled client grows server
  memory without bound — Carrier must bound or shed the per-session outbound queue.
- **Effect-everything** (opencode) / **~80-crate sprawl** (codex). Replicate the
  *patterns* with Go primitives (goroutines, `x/sync/semaphore`, channels,
  `context`); resist the surface-area sprawl. The essential core is:
  loop + provider-adapter + tool-orchestrator + sandbox-helper + session (SQ/EQ) +
  rollout.

## Design implications for Carrier (prioritized)

1. **Define the canonical event type now.** `agent.StreamEvent` with
   text/reasoning/tool-input/tool-call/tool-result/step/usage/error deltas. Both
   adapters map into it; usage normalization happens here. (Extends the existing
   `internal/engine` seam.)
2. **Session runtime = SQ/EQ.** Bounded inbound channel (backpressure) + a
   **bounded** outbound channel (avoid codex's unbounded-EQ memory blow-up). One
   owning goroutine per session; coalescing wake; steer vs queue input;
   `context` cancel for interrupt.
3. **Tool concurrency from metadata.** `IsConcurrencySafe` / `IsReadOnly` →
   parallel read batches (`errgroup` + semaphore), serial write barriers; fire
   tools mid-stream; fail closed.
4. **Sandbox as a day-one interface.** `Executor` (local/container/microVM),
   out-of-process helper re-exec, hardcoded helper path, output caps, process-group
   kill. Block `ptrace`/`process_vm_*`/`io_uring` in the seccomp profile.
5. **Declarative permissions.** `{action, resource, effect: allow|deny|ask}` with
   wildcard matching, default `ask`, inheritable by subagents, independent of the
   sandbox gate. Optional fast-model auto-approve classifier for unattended,
   multi-session serving.
6. **Per-provider/per-model concurrency semaphores** to avoid 429 storms across
   many concurrent sessions (oh-my-openagent's `ConcurrencyManager`;
   `x/sync/semaphore` keyed by provider/model).
7. **Idle timeout on every stream `recv`** (codex 300s, claude-code 90s) so a hung
   SSE connection cannot pin a session goroutine forever — implement as a
   `context` deadline per receive.

## Techniques worth stealing

- **Spill oversized tool results to disk** (`maxResultSizeChars`) and cap output
  size to keep context lean (claude-code).
- **Lazy tool loading** via a search hint + a tool-search tool, so 50+ tool
  schemas are not paid for in context (claude-code, opencode `ToolSearch`).
- **Provider-agnostic error classifier** (retryable / stop / non-retryable, keyed
  on HTTP status + message patterns) feeding a model-fallback state machine
  (oh-my-openagent `model-error-classifier.ts`, `plugin/event-model-fallback.ts`).
- **Capability normalization** with multi-key readers that tolerate vendor naming
  drift (`topP`/`top_p`, `toolCall`/`tool_call`) and a resolution chain
  (runtime metadata → snapshot → heuristic family fallback) — oh-my `model-core`.
- **Sandbox-denial → escalation/unsandboxed-retry** as first-class control flow in
  the tool orchestrator, with per-request approval caching (codex `orchestrator.rs`).
- **Subagents as nested loops** with an isolated tool set and context budget,
  parallel fan-out, summarized results; auto-background long children
  (claude-code `tools/AgentTool/`, `coordinator/`).

## Open questions / decisions to make

- **Canonical wire shape:** Responses-style (codex) vs a neutral block model
  (opencode). Leaning Responses-shaped given streaming + reasoning + tool-call
  deltas, but it must round-trip Anthropic `thinking`/`tool_use` cleanly.
- **Sandbox backend for v1:** local helper (Seatbelt/bwrap, fastest to ship) vs
  managed (E2B) vs microVM (Firecracker). The `Executor` interface defers this,
  but v1 needs one concrete backend.
- **Store:** SQLite per instance vs Postgres shared. Stateless instances point to
  shared Postgres; the `Store` interface keeps it swappable.
- **Subagent model:** child goroutine running the same loop with a scoped registry,
  vs a separate session the parent polls. The former fits goroutine-per-session.

## Appendix: key file references

- **opencode** — loop `packages/core/src/session/runner/llm.ts`; events
  `packages/llm/schema/events.ts`; protocols
  `packages/llm/protocols/{anthropic-messages,openai-chat}.ts`; tools
  `tool/{tool,registry,builtins}.ts`; permissions `core/src/permission.ts`;
  coordinator `session/run-coordinator.ts`; store `core/src/database/database.ts`.
- **codex** — loop `core/src/session/turn.rs:215,1126,1977`,
  `core/src/tasks/regular.rs:73`; tools
  `core/src/tools/{router,orchestrator,parallel}.rs`; sandbox
  `sandboxing/src/seatbelt.rs:739`, `linux-sandbox/src/{bwrap.rs:234,landlock.rs:42}`,
  `core/src/exec.rs:297`; provider `model-provider-info/src/lib.rs:83`,
  `core/src/client.rs:1644`, `codex-api/src/sse/responses.rs`; session
  `core/src/session/session.rs:26`, `app-server/src/thread_state.rs:277`;
  persistence `rollout/src/{recorder.rs:76,state_db.rs}`.
- **claude-code 2.1.88** — loop `source/src/query.ts:307`; tool orchestration
  `services/tools/toolOrchestration.ts:91`, `StreamingToolExecutor.ts`; tool
  contract `Tool.ts:362`; sandbox `utils/sandbox/sandbox-adapter.ts`,
  `shouldUseSandbox.ts:130`; permissions `types/permissions.ts`; remote
  `remote/RemoteSessionManager.ts`; compaction `services/compact/`.
- **oh-my-openagent** — capabilities `packages/model-core/src/model-capabilities/`;
  error classifier `model-error-classifier.ts`; model fallback
  `plugin/event-model-fallback.ts`; concurrency
  `features/background-agent/concurrency.ts`.
