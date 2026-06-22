# Carrier

A server-side runtime for running coding agents at scale — many concurrent
sessions, provider-agnostic, built directly on the raw Anthropic and OpenAI
SDKs (no unifying agent framework).

> Status: **early skeleton.** The architecture and core loop are in place; the
> provider engines, sandbox, HTTP/SSE surface, and persistence layers are
> stubbed and marked `TODO`.

## Why

Coding-agent sessions are **I/O-bound**: almost all of their wall-clock time is
spent waiting on LLM API responses, sandboxed tool execution, and the database.
The runtime itself does very little CPU work — it is an I/O multiplexer that
shuffles bytes between the model, the sandbox, and the client.

That shapes two decisions:

- **Go.** One goroutine per session. Cheap concurrency, automatic multi-core
  use, and straightforward blocking-style code that the runtime schedules
  non-blockingly. The cost per idle, in-flight session is tiny, so a single
  instance holds many thousands of them.
- **Provider-agnostic, on raw SDKs.** A thin adapter (`Engine`) normalizes the
  Anthropic Messages API and the OpenAI Chat Completions API behind one
  interface. Swapping the model provider is swapping the engine; the agent loop
  never changes.

## The fleet metaphor

The carrier launches, runs, and recovers a fleet of aircraft. The codebase
borrows that vocabulary so the structure reads like the picture:

| Component | Package           | Role                                                        |
| --------- | ----------------- | ----------------------------------------------------------- |
| Carrier   | `cmd/carrier`     | The runtime itself — hosts and operates the fleet           |
| Flight    | `internal/flight` | One agent session = one goroutine driving the agent loop    |
| Tower     | `internal/tower`  | Flight control — launches, caps concurrency, cancels        |
| Engine    | `internal/engine` | Provider adapter (the brain): Anthropic / OpenAI            |
| Bay       | `internal/bay`    | The hangar deck — isolated sandbox where tool calls execute |
| Fleet     | —                 | All in-flight Flights at once                               |

The provider-agnostic message and tool types every component speaks live in
`internal/agent`.

## Layout

```
cmd/carrier/        entrypoint — wires Tower + Engine + Bay, launches a Flight
internal/agent/     normalized Message / Tool / StepResult types (the contract)
internal/engine/    Engine interface + Anthropic / OpenAI adapters (stubbed)
internal/flight/    the agent loop for a single session
internal/tower/     concurrency-capped Flight dispatcher
internal/bay/       sandbox interface + a no-op LocalBay placeholder
```

## Build & run

Requires Go 1.23+ (pinned to `1.26.4` via `.tool-versions` for asdf).

```sh
go build ./...
go run ./cmd/carrier
```

The skeleton launches one Flight; it will report that the Anthropic engine is
not implemented yet — that is expected until an engine is wired.

## Roadmap

- Wire the Anthropic and OpenAI engines (streaming, tool-call normalization)
- Back the Bay with a real sandbox (Docker / E2B), one per Flight
- HTTP + SSE surface so clients can stream a Flight
- Persistence (Postgres) and a job queue for long-running Flights
- Backpressure and per-tenant concurrency limits
