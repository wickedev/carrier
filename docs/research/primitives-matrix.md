# Primitive Matrix: Agent-Harness Capabilities

A second-pass analysis of four coding-agent codebases along **14 primitive
axes**, to decide which capabilities Carrier builds, in what order, and which
existing implementation to use as the reference for each.

Companion to [`prior-art.md`](./prior-art.md) — that document covers the core
*architecture* (loop, provider abstraction, sandboxing, session model); this one
inventories *primitives* (tools, MCP, skills, hooks, memory, permissions, etc.).

Sources (same as prior-art):

- [opencode](https://github.com/anomalyco/opencode) — TS/Effect, multi-session server
- [codex](https://github.com/openai/codex) — Rust, ~80-crate CLI + daemon
- claude-code 2.1.88 — TS, unminified source at `source/src/`
- [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) — TS, distribution layer **on top of** opencode (many axes are outsourced upstream)

Legend: ✓ first-class · ◐ partial · ✗ absent.

## Master matrix

| # | Axis | opencode | codex | claude-code | oh-my-openagent |
|---|------|----------|-------|-------------|------------------|
| 1 | Tools | ✓ Effect Schema, mandatory truncation | ✓ 4-state exposure enum, spec/handler split | ✓ rich contract (fused with TUI) | ◐ registry only, dispatch outsourced |
| 2 | MCP | ✓ HTTP→SSE fallback, OAuth | ✓ **client + server**, 3 transports | ✓ incl. in-process linked-pair | ◐ 3-tier, per-session client keying |
| 3 | Skills | ✓ permission-gated skill tool | ✓ `openai.yaml` sidecar | ✓ inline/forked dual execution | ✓ single gateway tool |
| 4 | Hooks | ✓ 17+ points, in-place mutation | ✓ 10 events, **layer-aware trust** | ✓ ~25 events, programmable permission | ✓ 5-tier composition, 20+ guards |
| 5 | Subagent / multi-agent | ✓ full sessions, asymmetric perm inheritance | ✓ weak-ref registry, fan-out ≤64 | ✓ **cache-aligned forks**, coordinator | ✓ Team Mode (file mailbox) |
| 6 | Plan / Reflection | ✓ plan→file (no auto-critique) | ✓ **constrained review sub-agent** | ✓ plan = permission mode + tool filter | ✓ Metis/Prometheus/Momus pipeline |
| 7 | Memory (long-term) | ◐ instruction files only | ✓ git-versioned LLM-consolidated | ✓ layered (project files + session extraction) | ◐ Boulder work JSON |
| 8 | Context / Compaction | ✓ reactive, tombstoned outputs | ✓ 3 impls + **model-callable budget tools** | ✓ **cache-safe frozen replacement** | ✓ **proactive 78% + config checkpoint** |
| 9 | Checkpoint / Session state | ✓ **git-snapshot workspace** | ✓ JSONL + zstd + backward-replay resume | ✓ JSONL UUID-chain, fd-level skip | ◐ work only, session outsourced |
| 10 | Permissions / Approval | ✓ flat glob, batched `always` | ✓ **layered Granular** | ✓ source precedence + off-loop classifier | ◐ deny-by-throw guards |
| 11 | Human-in-the-loop / Interrupt | ✓ 2-layer, separate question channel | ✓ **SQ/EQ, triple idle re-check** | ✓ **control_request/response** | ✓ tmux keystrokes (dead end) |
| 12 | Sandbox / Isolation | ✗ permission-gating only | ✓ **arg0 self-re-exec, bwrap+Landlock** | ✓ sandbox-runtime, **sandbox/perm split** | ✗ XDG/temp only |
| 13 | Slash commands / Workflow | ✓ unified registry | ✓ hardcoded enum, mode templates | ✓ **command ≡ skill** | ◐ keyword-detector mode injection |
| 14 | Observability / Cost · Trace | ✓ Decimal tiered pricing (per-message) | ✓ OTel + facts + **ToolDecisionSource** | ✓ **cache-aware cost + OTel span tree** | ✗ daily-ping only |

> oh-my-openagent outsources the loop, session DB, MCP client lifecycle,
> permission prompt, and sandbox to upstream opencode; its ✓ cells are the layer
> it adds on top (skills, hooks composition, team mode, proactive compaction).

## Best-in-class reference per axis (for Carrier)

| Axis | Reference | Pattern to lift |
|------|-----------|-----------------|
| Tools | claude-code (contract) + codex (exposure enum) | Drop the UI surface; keep `Call`/schema/permission/predicates. `IsConcurrencySafe`, `maxResultSize`, defer-loading, 4-state visibility (Direct/Deferred/ModelOnly/Hidden). |
| MCP | claude-code / codex | **In-process linked-pair transport** for first-party servers; client + server modes; `mcp__<server>__<tool>` namespacing; `_meta` hints (alwaysLoad/searchHint). |
| Skills | all (convergent) | **Single gateway tool + progressive disclosure** — surface frontmatter (name+description) only, load `SKILL.md` body on mention/invocation. |
| Hooks | codex (trust) + claude-code | In Go, a **typed middleware chain** (return-new, not in-place mutate). Layer-aware trust: project/plugin layers can never grant trust — only user/session. |
| Subagent | codex + claude-code | Weak-ref session registry (→ Go: ctx + session-scoped store, no globals); `FuturesUnordered` fan-out (→ errgroup + bounded pool); TOML roles; cache-aligned fork prefixes. |
| Plan / Reflection | codex | **Constrained review sub-agent**: a separate sub-conversation with a hard-locked permission profile (no network, local-only writes, optionally a cheaper model). |
| Memory | claude-code | Layered project files + **off-loop session extraction** (forked subagent). Defer codex's git-versioned LLM memory (heavy). |
| Compaction | claude-code + oh-my | Cache-safe **frozen replacement** keyed by tool_use_id; **proactive threshold** before the provider forces it, with **checkpoint/restore of agent/model/tool/todo config** across the boundary. |
| Checkpoint | opencode + codex | **Bare git repo per session worktree** for workspace snapshots (restore/diff/revert); JSONL rollout + backward-replay resume. |
| Permissions | codex + claude-code | **Layered Granular** gates (sandbox/rules/skill/mcp independently); source precedence (managed > user); auto-approve classifier run **off the main loop** on a sanitized projection. |
| HITL / Interrupt | codex + claude-code | **SQ/EQ input queue** with steer-vs-mailbox split and **triple idleness re-check** (→ Go `select` over stream chan + mailbox chan); **control_request/response with requestId** for remote approval round-trips. |
| Sandbox | codex (gold standard) | **arg0 self-re-exec** (one binary dispatched on `argv[0]` — no separate helper to ship); bwrap (namespaces+binds) + Landlock/seccomp + net-namespace. macOS Seatbelt is dev-only. |
| Slash / Workflow | claude-code | **command ≡ skill** (one loader/permission/discovery path); output styles = pure prompt injection, no behavior code. |
| Observability | claude-code + codex | Cache tokens accounted **separately** from input/output; OTel span tree (interaction→llm→tool→hook) via context propagation; `ToolDecisionSource` tags *why* each tool decision happened (autonomy audit). |

## Cross-cutting signals (3+ projects agree → Carrier defaults)

1. **Progressive disclosure via a single skill gateway tool** (all four). Surface
   only metadata; load bodies on demand. Combined with tool-search deferral, this
   keeps a 50-tool + N-MCP pool affordable in context.
2. **Cache-safety is the spine, not a feature.** claude-code engineers fork,
   eviction, and resume to keep the API wire-prefix byte-identical so the
   server-side cache hits. For a token-billed server: immutable, content-addressed
   message/tool-result records and deterministic serialization, from day one.
3. **Side-channel everything expensive.** Permission classifier, memory
   extraction, and compaction all run off the main loop (side queries / forked
   subagents). Maps exactly onto goroutine-per-session — spawn children, never
   inline.
4. **Sandbox = out-of-process re-exec** (codex, claude-code). opencode and
   oh-my-openagent have *no* real isolation — Carrier's differentiator. codex's
   arg0 trick is the most directly Go-portable.
5. **Layered permissions beat a single allow/deny/ask flag** (codex,
   claude-code). Independently gateable categories + source precedence
   (managed > user). Mandatory for untrusted multi-tenant repos.
6. **JSONL append-only + backward-replay resume** (codex, claude-code).
   Human-inspectable, background-compressible, paired with a SQLite metadata index
   for listing/resume.

## Carrier roadmap implications

This 14-axis pass adds a concrete primitive build-order to the architecture
decisions in `prior-art.md`:

1. **Now (on the core loop).** Canonical `StreamEvent` type + **SQ/EQ session
   runtime** (triple idle re-check) + **JSONL store** (backward-replay resume) +
   **cache-safe message/tool-result records** (immutable, frozen replacement).
2. **Next (tools + permissions).** UI-less **Tool contract**
   (`IsConcurrencySafe`/`IsReadOnly`/exposure enum) + **layered Granular
   permissions** (source precedence, off-loop classifier) + **Executor/sandbox**
   (arg0 re-exec, bwrap+Landlock).
3. **Then (extension surface).** **Single skill gateway** + MCP (incl.
   in-process) + **typed middleware hooks** + **constrained review sub-agent** +
   **proactive compaction with config checkpoint** + **per-worktree git-snapshot
   checkpoints**.
4. **Cross-cutting (observability).** Cache-token-aware cost accounting + OTel
   span tree (context propagation) + `ToolDecisionSource` audit.

### Deferred / not for Carrier

- codex's git-versioned, LLM-consolidated long-term memory (`~/.codex/memories/.git`) — heavy; start with project files + off-loop session extraction.
- codex's TUI slash-command enum (~67 variants) — desktop-shaped, irrelevant to a server; keep the per-turn prompt-template builder, drop the enum.
- oh-my-openagent's tmux-keystroke steering and file-based mailbox coordination — a server uses channels/queues into the session goroutine, not synthesized keystrokes or 3s file polls.

## Appendix: key file references

Traceable entry points per axis. Paths are repo-relative (codex under `codex-rs/`,
claude-code under `source/src/`).

**opencode** — tools `tool/{tool,registry,json-schema}.ts`; MCP
`mcp/{index,catalog,oauth-provider,auth}.ts`; skills
`skill/{index,discovery}.ts`, `tool/skill.ts`; hooks `packages/plugin/src/index.ts`,
`plugin/index.ts`; subagent `tool/task.ts`, `agent/subagent-permissions.ts`;
plan `agent/agent.ts`, `tool/plan.ts`; memory `session/instruction.ts`;
compaction `session/compaction.ts`, `session/overflow.ts`; checkpoint
`snapshot/index.ts`, `session/revert.ts`, `storage/storage.ts`; permissions
`permission/index.ts`; interrupt `session/run-state.ts`, `session/processor.ts`,
`question/index.ts`; commands `command/index.ts`; observability
`session/session.ts` (getUsage), `cli/cmd/run/trace.ts`.

**codex** — tools `core/src/tools/{registry,router}.rs`, `tools/src/tool_spec.rs`;
MCP `rmcp-client/src/rmcp_client.rs`, `mcp-server/src/lib.rs`,
`core/src/tools/handlers/mcp.rs`; skills `core-skills/src/{loader,injection}.rs`;
hooks `hooks/src/{lib,registry,engine}.rs`; subagent
`core/src/agent/{control,registry}.rs`, `tools/handlers/multi_agents/`; plan
`core/src/tools/handlers/plan.rs`, `core/src/session/review.rs`; memory
`memories/README.md`, `rollout/src/state_db.rs`, `core/src/agents_md.rs`;
compaction `core/src/context_manager/history.rs`, `core/src/compact.rs`,
`state/auto_compact_window.rs`; checkpoint `rollout/src/{recorder,compression}.rs`,
`core/src/session/rollout_reconstruction.rs`; permissions `core/src/exec_policy.rs`,
`tools/network_approval.rs`; interrupt `core/src/session/{input_queue,inject}.rs`;
sandbox `sandboxing/src/{manager,seatbelt,landlock,bwrap,windows}.rs`,
`arg0/src/lib.rs`; commands `tui/src/slash_command.rs`,
`collaboration-mode-templates/`; observability `otel/`, `analytics/`,
`rollout-trace/src/tool_dispatch.rs`, `core/src/session/{token_budget,rollout_budget}.rs`.

**claude-code 2.1.88** — tools `Tool.ts`, `tools.ts`,
`services/tools/toolExecution.ts`, `utils/zodToJsonSchema.ts`; MCP
`services/mcp/{client,InProcessTransport,mcpStringUtils}.ts`,
`tools/{MCPTool,McpAuthTool}/`; skills `tools/SkillTool/SkillTool.ts`,
`skills/loadSkillsDir.ts`; hooks `types/hooks.ts`, `utils/hooks.ts`,
`services/tools/toolHooks.ts`; subagent `Task.ts`,
`tools/AgentTool/{runAgent,loadAgentsDir,forkSubagent}.ts`,
`coordinator/coordinatorMode.ts`; plan
`tools/{EnterPlanModeTool,ExitPlanModeTool}/`; memory `memdir/memdir.ts`,
`services/SessionMemory/sessionMemory.ts`, `services/teamMemorySync/`; compaction
`services/compact/{autoCompact,microCompact}.ts`, `utils/toolResultStorage.ts`;
checkpoint `utils/sessionStorage.ts`, `tools/AgentTool/resumeAgent.ts`;
permissions `types/permissions.ts`, `utils/permissions/{permissions,yoloClassifier,denialTracking}.ts`;
interrupt `tools/AskUserQuestionTool/`, `remote/{SessionsWebSocket,RemoteSessionManager}.ts`;
sandbox `utils/sandbox/sandbox-adapter.ts`, `tools/BashTool/shouldUseSandbox.ts`;
commands `commands.ts`, `constants/outputStyles.ts`; observability
`cost-tracker.ts`, `costHook.ts`, `services/analytics/sink.ts`,
`utils/telemetry/sessionTracing.ts`.

**oh-my-openagent** — tools `packages/omo-opencode/src/plugin/tool-registry.ts`,
`tools/{grep,skill}/tools.ts`; MCP `src/mcp/index.ts`,
`mcp-client-core/src/skill-mcp-manager/manager.ts`; skills
`packages/skills-loader-core/.../opencode-skill-loader/loader.ts`; hooks
`src/plugin-interface.ts`, `plugin/tool-execute-before.ts`; subagent
`agents/builtin-agents.ts`, `features/background-agent/{manager,concurrency}.ts`,
`features/team-mode/`, `team-core/`; plan `agents/{metis,momus,prometheus}.ts`,
`boulder-state/src/plan-checklist.ts`; memory `packages/boulder-state/src/storage/`,
`agents-md-core/src/injector.ts`; compaction
`hooks/preemptive-compaction-trigger.ts`, `plugin/session-compacting.ts`;
permissions `hooks/{write-existing-file-guard,team-tool-gating}/`; interrupt
`packages/openclaw-core/src/`, `hooks/session-notification.ts`; sandbox
`packages/git-bash-mcp/src/runner.ts`; commands `cli/cli-program.ts`,
`hooks/keyword-detector/hook.ts`; observability `packages/telemetry-core/src/`.
