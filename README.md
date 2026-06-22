# Carrier

A server-side runtime for running coding agents at scale — many concurrent
sessions, provider-agnostic, built directly on the raw Anthropic and OpenAI
SDKs (no unifying agent framework), with tool execution in isolated sandboxes.

> Status: **working core.** The end-to-end path runs — `HTTP → Tower → Flight
> (agent loop) → Engine → tool dispatch → sandbox → SSE`. Provider adapters,
> sandboxing, permissions, persistence, compaction, skills, MCP, hooks,
> subagents, and the HTTP/SSE server are implemented and tested (`go test
> -race ./...`). See `.kiro/specs/carrier/tasks.md` for per-task status; the
> Linux sandbox backend cross-compiles but is unverified on non-Linux hosts.

## Why

Coding-agent sessions are **I/O-bound**: almost all of their wall-clock time is
spent waiting on LLM API responses, sandboxed tool execution, and the database.
The runtime is an I/O multiplexer that shuffles bytes between the model, the
sandbox, and the client.

- **Go.** One goroutine per session ("Flight"). Cheap concurrency, automatic
  multi-core use, blocking-style code the runtime schedules non-blockingly.
- **Provider-agnostic, on raw SDKs.** A thin `Engine` adapter normalizes
  Anthropic and OpenAI into one canonical streaming-event model; swapping the
  provider never touches the loop.
- **Isolated execution.** Tools run through a `bay.Executor` (Seatbelt on macOS,
  bubblewrap on Linux), never `os/exec` directly.

## The fleet metaphor

| Component | Package | Role |
| --------- | ------- | ---- |
| Carrier | `cmd/carrier` | the runtime — hosts and operates the fleet |
| Flight | `internal/flight` | one agent session = one goroutine driving the loop |
| Tower | `internal/tower` | flight control — launches, caps concurrency, cancels |
| Engine | `internal/engine` | provider adapter (the brain): Anthropic / OpenAI, + throttle |
| Bay | `internal/bay` | the hangar deck — isolated sandbox where tools execute |
| Fleet | — | all in-flight Flights at once |

## Layout

```
cmd/carrier/         entrypoint — `serve` (HTTP) and a one-shot smoke test
internal/agent/      canonical types: Message, StreamEvent, ToolCall, Usage, EngineError
internal/engine/     Engine interface + Anthropic/OpenAI adapters + concurrency Throttle
internal/sq/         per-session submission (SQ) + event (EQ) queues, coalesced wake
internal/flight/     the agent loop: turns, tool dispatch, compaction, plan mode
internal/tower/      concurrency-capped Flight dispatcher + live registry
internal/tool/       Tool contract, registry, concurrency-safe partitioned dispatch
internal/bay/        Executor interface + Local/Seatbelt/bwrap sandbox backends
internal/perm/       declarative permission rules + classifier + denial tracker
internal/hitl/       human-in-the-loop ChannelApprover (request/response by ID)
internal/store/      append-only JSONL store + index + backward-replay resume
internal/checkpoint/ per-session bare-git workspace snapshots (restore/diff/revert)
internal/memory/     AGENTS.md/CLAUDE.md walk-up instruction discovery
internal/skill/      SKILL.md discovery + single gateway tool (progressive disclosure)
internal/mcp/        stdlib MCP client (stdio + in-process), tool namespacing
internal/hook/       typed return-new middleware lifecycle hooks
internal/subagent/   child-Flight spawning, bounded fan-out, depth limit
internal/obs/        cache-aware cost accounting, span tracer, decision audit
internal/server/     HTTP + SSE surface, per-session fan-out hub, tenant auth
```

## Build & run

Requires Go 1.23+ (pinned to `1.26.4` via `.tool-versions` for asdf).

```sh
go build ./...
go test -race ./...

# Run the server (multi-session HTTP + SSE)
ANTHROPIC_API_KEY=... CARRIER_TOKEN=secret go run ./cmd/carrier serve
#   POST /v1/sessions                 create a session   -> {session_id}
#   POST /v1/sessions/{id}/input      send {text, steer}
#   GET  /v1/sessions/{id}/events     stream events (SSE)
# all requests: Authorization: Bearer <CARRIER_TOKEN>

# Or a one-shot local smoke test
ANTHROPIC_API_KEY=... go run ./cmd/carrier
```

## Design & specs

- `.kiro/specs/carrier/` — the spec-driven plan: `requirements.md` (EARS),
  `design.md` (Go interfaces + control flow), `tasks.md` (implementation status).
- `docs/research/prior-art.md` and `docs/research/primitives-matrix.md` — the
  comparative study of opencode, codex, claude-code, and oh-my-openagent that
  the architecture and primitive set are drawn from.

## Known gaps / follow-ups

- Linux sandbox (bubblewrap + seccomp/Landlock) cross-compiles but is unverified
  on a Linux host; seccomp syscall hardening is not yet wired.
- Live event IDs for exact SSE reconnect dedupe are not plumbed through `sq`
  (history records carry a `seq`; live events do not yet).
- MCP streamable-HTTP transport and OAuth are stubbed (stdio + in-process work).
- Subagent permission ceiling currently passes the parent policy through
  (deny-only inheritance is a follow-up).
