# Requirements Document

## Introduction

Carrier is a server-side, large-scale, provider-agnostic coding-agent runtime
written in Go. It runs many agent sessions concurrently — one goroutine per
session ("Flight") under a concurrency-capped dispatcher ("Tower") — built
directly on the raw Anthropic and OpenAI SDKs behind a thin normalization layer
("Engine"), with tool execution confined to isolated sandboxes ("Bay").

These requirements define the capabilities of the runtime. They are derived from
a comparative study of four existing coding-agent codebases (see
`docs/research/prior-art.md` and `docs/research/primitives-matrix.md`). Each
requirement uses EARS notation (WHEN/WHILE/IF-THEN/WHERE/SHALL) for its
acceptance criteria.

Terminology (fleet metaphor): **Carrier** = the runtime; **Flight** = one agent
session (one goroutine); **Tower** = the dispatcher owning Flight lifecycles and
concurrency; **Engine** = a provider adapter; **Bay** = an isolated sandbox where
a Flight's tools execute; **Fleet** = all in-flight Flights.

## Requirements

### Requirement 1 — Provider-agnostic Engine

**User Story:** As a runtime operator, I want one canonical internal model
interface that every provider maps into, so that the agent loop and all other
subsystems never branch on the vendor and a provider is swappable per session.

#### Acceptance Criteria

1. THE SYSTEM SHALL define a single canonical `StreamEvent` type covering text, reasoning, tool-input, tool-call, tool-result, step, usage, and error deltas.
2. THE SYSTEM SHALL expose an `Engine` interface whose `RunStep` performs exactly one model turn and emits `StreamEvent`s, never an internal multi-step loop.
3. WHEN an Anthropic response is received THE SYSTEM SHALL map its content blocks, `tool_use` blocks (parsed input), thinking blocks, and `stop_reason` into canonical `StreamEvent`s.
4. WHEN an OpenAI Chat Completions response is received THE SYSTEM SHALL map its `tool_calls` (JSON-string arguments parsed via `encoding/json`), system-as-`messages[0]`, and `finish_reason` into canonical `StreamEvent`s.
5. THE SYSTEM SHALL normalize token usage (input/output/cache-read/cache-write/reasoning) into one `Usage` representation per step.
6. WHERE a provider returns a recoverable error (rate limit, context overflow, transient 5xx) THE SYSTEM SHALL surface it as a typed, classified error variant rather than a raw provider error.
7. THE SYSTEM SHALL allow selecting the Engine per Flight such that changing provider is a single construction-time choice with no change to the loop.

### Requirement 2 — Session runtime & concurrency

**User Story:** As a runtime operator, I want each session to run as one cheap
goroutine under a bounded dispatcher, so that thousands of mostly-idle sessions
run concurrently without a thread-per-session cost.

#### Acceptance Criteria

1. THE SYSTEM SHALL run each Flight on its own goroutine.
2. THE SYSTEM SHALL enforce a configurable maximum number of concurrent Flights via a counting semaphore.
3. WHILE the concurrency cap is saturated THE SYSTEM SHALL apply backpressure to new Launch requests rather than exceeding the cap.
4. WHEN the dispatch context is cancelled while a Flight waits for a slot THE SYSTEM SHALL abandon the launch and report the cancellation.
5. THE SYSTEM SHALL provide a bounded inbound submission channel (SQ) per Flight and a bounded outbound event channel (EQ) per Flight.
6. IF the outbound event channel for a Flight reaches its bound THEN THE SYSTEM SHALL apply backpressure or shed events per a defined policy rather than growing memory without bound.
7. THE SYSTEM SHALL keep all mutable per-session state owned by the session's goroutine (or guarded), never shared unsynchronized across goroutines.
8. THE SYSTEM SHALL allow graceful shutdown that cancels in-flight Flights via context and waits for them to settle.

### Requirement 3 — Agent loop (Flight)

**User Story:** As a developer of agent behavior, I want a provider-agnostic
multi-step loop that dispatches tools and recovers from common failures, so that
a session runs to completion without per-caller recovery logic.

#### Acceptance Criteria

1. THE SYSTEM SHALL drive a multi-step loop that issues one Engine turn per step and continues while the model emits tool calls or pending input exists.
2. WHEN a turn produces no tool calls and no pending input THE SYSTEM SHALL end the loop and return the final assistant text.
3. THE SYSTEM SHALL enforce a maximum step budget per Flight and terminate with a typed error when exceeded.
4. WHEN a tool-call event completes during a stream THE SYSTEM SHALL be able to dispatch that tool without waiting for the full assistant message.
5. WHEN a tool execution fails THE SYSTEM SHALL feed the error back to the model as a tool result rather than aborting the Flight.
6. IF the context window is exceeded THEN THE SYSTEM SHALL trigger compaction and retry the turn as a loop transition.
7. WHILE awaiting a streaming receive THE SYSTEM SHALL enforce an idle timeout so a stalled provider stream cannot pin the session goroutine indefinitely.

### Requirement 4 — Tool system

**User Story:** As a tool author, I want a uniform tool contract with metadata
that drives concurrency and policy, so that tools execute safely and in parallel
where it is correct to do so.

#### Acceptance Criteria

1. THE SYSTEM SHALL define a tool contract exposing input schema (JSON Schema), an `Exec`-style call, and declarative predicates including `IsReadOnly` and `IsConcurrencySafe`.
2. THE SYSTEM SHALL default tool predicates to fail-closed (not concurrency-safe, not read-only) when unspecified.
3. WHEN a turn produces multiple tool calls THE SYSTEM SHALL run concurrency-safe (read-only) calls in a bounded parallel pool and serialize non-safe calls as ordering barriers.
4. THE SYSTEM SHALL produce one tool result per tool call, matched by tool-call ID.
5. WHERE a tool result exceeds a configured size THE SYSTEM SHALL spill it to storage and substitute a bounded preview.
6. THE SYSTEM SHALL support tool exposure states (model-visible, deferred/searchable, dispatch-only, hidden) so large tool pools do not all enter context.

### Requirement 5 — Sandbox / execution isolation

**User Story:** As a security owner, I want every tool command confined to an
isolated environment, so that untrusted, multi-tenant sessions cannot affect the
host or each other.

#### Acceptance Criteria

1. THE SYSTEM SHALL define an `Executor` interface that all tool execution routes through, never calling `os/exec` directly from tools.
2. THE SYSTEM SHALL provide at least one isolating Executor implementation that confines commands out-of-process via a re-exec wrapper.
3. WHEN running on Linux THE SYSTEM SHALL confine the filesystem via mount/namespace isolation and restrict network and dangerous syscalls (e.g. `ptrace`, `process_vm_*`, `io_uring`).
4. WHEN running on macOS THE SYSTEM SHALL confine commands via a generated Seatbelt policy with explicit readable/writable roots.
5. THE SYSTEM SHALL hardcode and validate the sandbox-helper invocation path to prevent PATH-injection escapes.
6. THE SYSTEM SHALL enforce per-execution output-size caps, a timeout, and process-group termination escalating from SIGTERM to SIGKILL.
7. WHERE a command fails due to a sandbox denial THE SYSTEM SHALL detect the denial signature and route it to the approval/escalation flow rather than reporting an opaque failure.

### Requirement 6 — Permissions & approval

**User Story:** As a runtime operator, I want declarative, layered permission
policy independent of sandboxing, so that unattended multi-session serving can
auto-decide safe actions and gate the rest.

#### Acceptance Criteria

1. THE SYSTEM SHALL evaluate permissions from declarative rules of the form `{action, resource-pattern, effect: allow|deny|ask}` with wildcard matching, defaulting to `ask`.
2. THE SYSTEM SHALL resolve rules by source precedence (managed/policy > project > user > session) with managed policy overriding user.
3. THE SYSTEM SHALL support independently gateable approval categories (e.g. sandbox escalation, command rules, skills, MCP) rather than a single flag.
4. WHEN a permission decision is `ask` THE SYSTEM SHALL block the requesting tool until a decision arrives and SHALL support an "always" decision that persists a rule.
5. WHERE an automated classifier is enabled THE SYSTEM SHALL run it off the main loop on a sanitized, security-relevant projection of the tool input.
6. IF consecutive automated denials exceed a configured threshold THEN THE SYSTEM SHALL fall back to explicit human approval.
7. THE SYSTEM SHALL keep permission evaluation independent of sandbox confinement such that a confined read may be auto-allowed.

### Requirement 7 — Human-in-the-loop & interrupt

**User Story:** As a client, I want to steer, interrupt, and approve a running
session, so that a long-lived Flight remains controllable mid-run.

#### Acceptance Criteria

1. THE SYSTEM SHALL accept user input mid-run with at least two delivery semantics: steer (interrupt and redirect the active turn) and queue (process on the next cycle).
2. WHEN a steer input arrives THE SYSTEM SHALL interrupt the active turn at a safe boundary and incorporate the new input.
3. WHEN an interrupt is requested THE SYSTEM SHALL cancel the active turn via context and bring the Flight to an idle state.
4. THE SYSTEM SHALL guard turn start against a race where queued input arrives between idleness check and turn start (idempotent idleness re-check).
5. THE SYSTEM SHALL support an approval round-trip identified by a request ID, decoupled from the transport, so a client can answer a specific pending request.
6. WHILE a Flight is blocked awaiting human input THE SYSTEM SHALL enforce a configurable timeout policy rather than blocking indefinitely.

### Requirement 8 — Persistence & checkpoint

**User Story:** As a runtime operator, I want crash-safe, resumable session
state, so that any stateless instance can recover or resume a Flight.

#### Acceptance Criteria

1. THE SYSTEM SHALL persist session events as an append-only log (one record per event) behind a `Store` interface.
2. THE SYSTEM SHALL maintain a separate metadata index for listing and resume.
3. WHEN resuming a session THE SYSTEM SHALL reconstruct conversation history by replaying the log to the most recent checkpoint.
4. THE SYSTEM SHALL persist replacement/preview records so resume reproduces byte-identical content for prompt-cache stability.
5. WHERE workspace checkpointing is enabled THE SYSTEM SHALL snapshot the Flight's working tree (e.g. a per-session bare git repository) and support restore and structured diff.
6. THE SYSTEM SHALL keep runtime instances stateless such that durable state lives in the `Store`, not in instance memory.

### Requirement 9 — Context management & compaction

**User Story:** As a cost owner, I want bounded, cache-safe context over long
sessions, so that token cost stays controlled without losing working state.

#### Acceptance Criteria

1. THE SYSTEM SHALL track context token usage per turn against the model's usable budget.
2. WHEN usage crosses a proactive threshold below the hard limit THE SYSTEM SHALL compact before the provider forces it.
3. WHEN compacting THE SYSTEM SHALL preserve recent turns and summarize older history, carrying any prior summary forward.
4. THE SYSTEM SHALL evict or tombstone stale tool results without invalidating the cached prompt prefix.
5. THE SYSTEM SHALL checkpoint agent/model/tool/todo configuration across a compaction boundary and restore it on continuation.
6. THE SYSTEM SHALL keep replacement decisions frozen (content-addressed by tool-call ID) so they are reproduced identically on resume.

### Requirement 10 — Skills

**User Story:** As a capability author, I want reusable skill packages loaded on
demand, so that large instruction sets do not occupy context until needed.

#### Acceptance Criteria

1. THE SYSTEM SHALL discover skills as packages with metadata (name, description) and a body, from configured scopes.
2. THE SYSTEM SHALL surface only skill metadata by default and load a skill body on demand through a single gateway tool.
3. WHEN the gateway tool is invoked for a skill THE SYSTEM SHALL apply permission checks and any per-skill agent/tool restrictions before returning the body.
4. WHERE a skill declares an agent restriction THE SYSTEM SHALL enforce it at invocation time.

### Requirement 11 — MCP (Model Context Protocol)

**User Story:** As an integrator, I want MCP tools available to Flights, so that
external capabilities plug in over a standard protocol.

#### Acceptance Criteria

1. THE SYSTEM SHALL act as an MCP client supporting stdio, streamable-HTTP, and in-process transports.
2. THE SYSTEM SHALL namespace MCP tools as `mcp__<server>__<tool>` and register them into the tool registry.
3. THE SYSTEM SHALL scope MCP client connections per session and disconnect idle connections.
4. WHERE an MCP server requires OAuth THE SYSTEM SHALL perform the auth flow and persist credentials securely.
5. WHEN an MCP tool output exceeds a size threshold THE SYSTEM SHALL offload it and provide a reference the model can read.

### Requirement 12 — Hooks

**User Story:** As an operator, I want lifecycle extension points, so that
policy, audit, and context injection happen without modifying the loop.

#### Acceptance Criteria

1. THE SYSTEM SHALL provide typed lifecycle hooks at minimum for pre-tool-use, post-tool-use, session-start, session-end, and pre/post-compaction.
2. THE SYSTEM SHALL implement hooks as a typed middleware chain that returns new values rather than mutating shared state in place.
3. WHEN a pre-tool-use hook returns a block decision THE SYSTEM SHALL prevent the tool from executing and surface the reason.
4. THE SYSTEM SHALL allow a pre-tool-use hook to rewrite tool input or append context before execution.
5. THE SYSTEM SHALL restrict trust-granting hook configuration to user/session layers such that project- or plugin-supplied configuration cannot grant its own trust.

### Requirement 13 — Subagents & multi-agent

**User Story:** As an agent author, I want to delegate to sub-agents with bounded
fan-out, so that independent work runs in parallel under a controlled permission
ceiling.

#### Acceptance Criteria

1. THE SYSTEM SHALL spawn a sub-agent as a child Flight (child goroutine) running the same loop with its own scoped tool registry and context.
2. THE SYSTEM SHALL derive the child's permission ceiling from the parent (inheriting deny rules) and allow the child to add capabilities only within that ceiling.
3. THE SYSTEM SHALL bound parallel sub-agent fan-out by a configurable maximum concurrency.
4. THE SYSTEM SHALL bound sub-agent recursion depth per session tree.
5. WHEN a sub-agent completes THE SYSTEM SHALL return a summarized result to the parent rather than the full child transcript.
6. WHERE a sub-agent runs long THE SYSTEM SHALL support backgrounding it and notifying the parent on completion.

### Requirement 14 — Plan & reflection

**User Story:** As a user, I want a plan-first mode and a constrained review
pass, so that complex work is proposed before it mutates state and is critiqued
before it is accepted.

#### Acceptance Criteria

1. WHILE in plan mode THE SYSTEM SHALL restrict tools to a read-only/plan-writing set and forbid mutating actions.
2. THE SYSTEM SHALL persist a produced plan to a durable file so planning is checkpointable outside session context.
3. THE SYSTEM SHALL support a review sub-agent that runs as a separate sub-conversation with a hard-locked permission profile (no network, local-only writes), optionally on a cheaper model.
4. WHEN plan mode exits THE SYSTEM SHALL not restore into an auto-approval mode (escalation circuit-breaker).

### Requirement 15 — Long-term memory

**User Story:** As a returning user, I want durable project and session memory,
so that context persists across sessions without bloating the live loop.

#### Acceptance Criteria

1. THE SYSTEM SHALL discover and inject project instruction files (e.g. AGENTS.md/CLAUDE.md) found by walking from the working directory upward.
2. THE SYSTEM SHALL inject instruction context without placing it in the mutable conversation history where it would be compacted.
3. WHERE session memory extraction is enabled THE SYSTEM SHALL run it off the main loop (e.g. a forked sub-agent) on a token/turn threshold.
4. THE SYSTEM SHALL deduplicate repeated instruction-file injection within a session.

### Requirement 16 — Observability, cost & trace

**User Story:** As an operator, I want per-session cost and traceability, so that
spend and behavior are auditable across many concurrent sessions.

#### Acceptance Criteria

1. THE SYSTEM SHALL account token usage and cost per session, accounting cache-read and cache-write tokens separately from input/output.
2. THE SYSTEM SHALL aggregate cost per session (and per tenant) rather than only per message.
3. WHERE tracing is enabled THE SYSTEM SHALL emit a span hierarchy (session → turn → tool → hook) propagated via `context.Context`.
4. THE SYSTEM SHALL record, for each tool decision, the source of the decision (user, rule, classifier, hook) for autonomy auditing.
5. THE SYSTEM SHALL guard hot-path tracing so that disabled tracing incurs no formatting/allocation cost.

### Requirement 17 — Server & API surface

**User Story:** As a client developer, I want to drive and observe Flights over a
network API, so that many clients can create sessions and stream their events.

#### Acceptance Criteria

1. THE SYSTEM SHALL expose an HTTP API to create a session, send input, and stream events.
2. THE SYSTEM SHALL stream session events to clients incrementally (e.g. SSE) decoupled from the core via a channel boundary.
3. THE SYSTEM SHALL support many clients observing one session and one client driving many sessions.
4. WHEN a streaming client disconnects and reconnects THE SYSTEM SHALL allow it to resume without losing events (history fetch + dedupe by event ID).
5. THE SYSTEM SHALL authenticate API requests and isolate sessions per tenant.
