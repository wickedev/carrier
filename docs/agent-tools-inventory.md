# Agent Local-Tools Inventory

A complete listing of the **local/built-in tools** exposed to the model by four
coding agents, for comparison and to scope what Carrier could adopt.

**Method.** Claude Code is closed source — its tools are listed from the live
tool surface (authoritative). Codex and OpenCode were `git clone`d and read from
source on 2026-06-26:

- **Codex** — `github.com/openai/codex` → `codex-rs/core/src/tools/handlers/*_spec.rs`
  (the specs advertised to the model).
- **OpenCode** — `github.com/sst/opencode` → `packages/opencode/src/tool/*.ts`
  (each `*.txt` is the model-facing description).
- **Carrier** — this repo: `internal/tool/`, `cmd/carrier/session.go`.

> Tool sets move fast; names/params reflect the cloned `main` at the date above.
> "MCP tools" (dynamically loaded from configured MCP servers) are available in
> all four and are omitted from the per-agent lists.

---

## 1. Claude Code

| Tool | Purpose | Key params |
|---|---|---|
| **Bash** | Run a shell command (persistent cwd, sandbox, background) | `command`, `timeout`, `run_in_background`, `description` |
| **Read** | Read a file — text, image, PDF, or Jupyter notebook | `file_path`, `offset`, `limit`, `pages` (PDF) |
| **Write** | Write/overwrite a file | `file_path`, `content` |
| **Edit** | Exact string replacement in a file | `file_path`, `old_string`, `new_string`, `replace_all` |
| **Glob** | Fast file-name pattern match | `pattern`, `path` |
| **Grep** | ripgrep content search with structured output | `pattern`, `path`, `glob`, `type`, `output_mode`, `-i/-n/-A/-B/-C`, `multiline`, `head_limit` |
| **Task** (Agent) | Launch a subagent | `description`, `prompt`, `subagent_type`, `model`, … |
| **TodoWrite** | Maintain a structured task list | `todos[]` |
| **NotebookEdit** | Edit a Jupyter notebook cell | `notebook_path`, `cell_id`, `new_source`, `cell_type`, `edit_mode` |
| **WebFetch** | Fetch a URL and process with a prompt | `url`, `prompt` |
| **WebSearch** | Web search | `query`, `allowed_domains`, `blocked_domains` |
| **BashOutput** | Read output from a background shell | `bash_id`, `filter` |
| **KillShell** | Kill a background shell | `shell_id` |
| **SlashCommand** | Invoke a slash command | `command` |
| **AskUserQuestion** | Ask the user a multiple-choice question | `questions[]` |
| **ExitPlanMode** | Leave plan mode with a plan | `plan` |

Philosophy: **rich first-class file tools** (Read/Write/Edit/Glob/Grep) + a
sandboxed Bash. Edits are exact-string-match, not diffs.

---

## 2. Codex (OpenAI)

From `codex-rs/core/src/tools/handlers/*_spec.rs`.

| Tool | Purpose | Notes |
|---|---|---|
| **shell** | Run a command | the canonical exec tool |
| **exec_command** | Start/drive a (possibly interactive) command session | `session_id`, `chars`, `yield_time_ms`, `max_output_tokens`, `login`, `environment_id` (the "unified exec" model) |
| **write_stdin** | Write to a running `exec_command` session's stdin | streaming/interactive REPLs |
| **apply_patch** | **All file edits** via a patch envelope | lark grammar; `*** Add/Update/Delete File` blocks |
| **update_plan** | Maintain a step plan | `plan: [{step, status}]`, `explanation` |
| **view_image** | Attach a local image to context | `path` |
| **tool_search** | Search/load deferred tools on demand | keeps the tool list small |
| **multi_agents** | Spawn/coordinate sub-agents | |
| **agent_jobs** | Background agent jobs | |
| **mcp_resource** | Read an MCP resource | |
| **get_context_remaining** | Query remaining context budget | |
| **new_context_window** | Start a fresh context window (compaction) | |
| **request_user_input** | Ask the user a question | |
| **list_available_plugins_to_install** / **request_plugin_install** | Plugin discovery/install | |
| **web_search** | Hosted web search | config-gated (`tools.web_search`) |

Philosophy: **shell + `apply_patch`**. Codex has **no** first-class
read/write/edit/grep/glob/ls — it reads & searches via `shell` and makes *every*
edit through `apply_patch`. It adds substantial orchestration tooling
(multi-agents, tool_search, context-window management, plugin install).

---

## 3. OpenCode (sst)

From `packages/opencode/src/tool/*.ts` (+ `*.txt` descriptions).

| Tool | Purpose | Key params |
|---|---|---|
| **read** | Read a file or directory (LSP-aware) | `filePath`, `offset`, `limit` |
| **write** | Write a file (runs LSP diagnostics after) | `filePath`, `content` |
| **edit** | Exact string replacement (LSP diagnostics after) | `filePath`, `oldString`, `newString`, `replaceAll` |
| **apply_patch** | Multi-file patch-envelope edits | patch text |
| **grep** | ripgrep content search | `pattern`, `path`, `include` |
| **glob** | Fast file pattern match | `pattern`, `path` |
| **shell** (bash) | Run a command | `command`, `description`, `timeout` |
| **task** | Launch a subagent | `description`, `prompt`, `subagent_type` |
| **todowrite** / **todoread** | Maintain a task list | `todos: [{content, status, priority}]` |
| **webfetch** | Fetch a URL | `url`, `format`, `timeout` |
| **websearch** | Web search | `query`, `numResults`, `livecrawl`, `type`, … |
| **question** | Ask the user a question mid-run | |
| **plan** | Enter/exit plan mode | |
| **skill** | Invoke a named skill | |
| **lsp** | LSP diagnostics / hover | mostly edit-time |

Philosophy: **Claude-Code-style first-class file tools** *and* `apply_patch`,
plus deep **LSP** integration (diagnostics surfaced after every write/edit).

---

## 4. Carrier (today)

From `internal/tool/` + `cmd/carrier/session.go`.

| Tool | Purpose |
|---|---|
| **bash** | Run a shell command in the session sandbox (`bay.Executor`, session `cwd`/env) |
| **Task** | Spawn a subagent (`internal/subagent`) |
| **skill** gateway | Invoke an in-memory skill |
| *(MCP)* | Tools from configured MCP servers (dynamic) |
| *(plugins)* | Tools/seams from WASM plugins |

**Tool interface** (`internal/tool/tool.go`):
`Name / Description / Schema(JSON Schema) / IsReadOnly / IsConcurrencySafe /
Exposure / Exec`. **ExecContext** carries `Executor` (sandbox), `Cwd`, `Env`,
`Spiller` (large-output spill), `MaxResultBytes`.

Philosophy: **shell-centric, like minimal Codex** — every file operation goes
through `bash` (`cat`/`sed`/`grep`/`find`). No first-class file tools.

---

## 5. Cross-agent matrix

| Capability | Claude Code | Codex | OpenCode | Carrier |
|---|:--:|:--:|:--:|:--:|
| Shell exec | Bash | shell / exec_command | shell | **bash** |
| Interactive shell (stdin) | — | write_stdin | — | — |
| Read file | Read | *(shell)* | read | *(bash)* |
| Write file | Write | *(apply_patch)* | write | *(bash)* |
| Edit (exact-match) | Edit | — | edit | *(bash)* |
| Patch envelope (multi-file) | — | apply_patch | apply_patch | — |
| File glob | Glob | *(shell)* | glob | *(bash)* |
| Content grep | Grep | *(shell)* | grep | *(bash)* |
| List dir | *(Glob/Bash)* | *(shell)* | read(dir) | *(bash)* |
| Subagents | Task | multi_agents / agent_jobs | task | **Task** |
| Todo / plan list | TodoWrite | update_plan | todowrite | *(harness)* |
| Plan mode | ExitPlanMode | — | plan | *(planMode flag)* |
| Ask user | AskUserQuestion | request_user_input | question | *(HITL approve)* |
| Web fetch | WebFetch | — | webfetch | *(MCP)* |
| Web search | WebSearch | web_search | websearch | *(MCP)* |
| Image input | Read(image) | view_image | *(read)* | — |
| Notebook | NotebookEdit | — | — | — |
| LSP diagnostics | *(via edits)* | — | **lsp** | — |
| Deferred-tool search | *(ToolSearch)* | tool_search | — | — |
| MCP resources | *(MCP)* | mcp_resource | *(MCP)* | *(MCP)* |
| Context-budget tools | — | get_context_remaining / new_context_window | — | — |
| Skills | *(skills)* | *(ext skills)* | skill | **skill** |

---

## 6. What Carrier is missing (and could adopt)

Carrier sits at the **minimal-Codex** end: `bash` for everything file-related.
The biggest, lowest-risk additions — present in both Claude Code and OpenCode —
are **first-class file tools**:

| Add | IsReadOnly | ConcurrencySafe | Why it helps Carrier |
|---|:--:|:--:|---|
| **read** | ✅ | ✅ | line-range reads, image/PDF, cheaper than `cat` |
| **grep** | ✅ | ✅ | structured ripgrep output, less token noise than shell |
| **glob** | ✅ | ✅ | fast file discovery |
| **ls** | ✅ | ✅ | directory listing |
| **edit** | ❌ | ❌ | exact-match replace — removes `sed`/escaping fragility |
| **write** | ❌ | ❌ | direct file create/overwrite |

Carrier's `Tool` interface already has the exact hooks these need:

- `IsReadOnly` → these read-only tools become usable in **plan mode** (today
  `bash` is non-read-only, so plan mode has effectively *no* tools — see
  `flight.visibleTools`). This makes the per-turn **Plan** mode actually useful.
- `IsConcurrencySafe` → read/grep/glob run in **parallel** within a turn
  (today `bash` is fail-closed serial).
- `ExecContext.{Cwd, Executor, Spiller, MaxResultBytes}` → sandboxing, session
  env, and large-output truncation are already wired.

**Edit style:** prefer `edit` (exact string match, as Claude Code/OpenCode) over
Codex's `apply_patch` — simpler to validate; add `multi_edit` later if needed.

**Lower priority:** web (better via MCP given Carrier's network sandbox), todo
(harness owns it), notebook, LSP diagnostics.

**Effort:** ~6 tools × ~40–80 LOC Go + tests; register in
`cmd/carrier/session.go` alongside `bash`. Plan-mode/permission/concurrency reuse
existing predicates — minimal new wiring. ≈ 1–2 days.
