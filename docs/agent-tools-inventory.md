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

From `internal/tool/` + `cmd/carrier/session.go`. Carrier now ships first-class
file/search/edit tools alongside `bash`.

| Tool | Purpose |
|---|---|
| **bash** | Run a shell command in the session sandbox (`bay.Executor`, session `cwd`/env). `run_in_background` launches a long-running process and returns a shell ID |
| **bash_output** | Drain new output from a background shell (`bash_id`, optional `filter` regex) |
| **write_stdin** | Write to a background shell's stdin — drive interactive REPLs (`bash_id`, `input`) |
| **kill_shell** | Terminate a background shell (`shell_id`) |
| **read** | Read a file with optional line range |
| **ls** | List a directory |
| **glob** | Fast file-name pattern match |
| **grep** | ripgrep-style content search |
| **write** | Create/overwrite a file |
| **edit** | Exact-string replacement |
| **multi_edit** | Multiple exact-string edits to one file, applied atomically |
| **apply_patch** | Multi-op patch envelope (validate-all-then-apply) |
| **notebook_edit** | Edit a Jupyter notebook cell |
| **view_image** | Attach a local image (PNG/JPEG/GIF/WebP) to context as vision input (`path`); confined to the working dir |
| **lsp** | Language-server diagnostics (errors/warnings) or hover (`path`, optional `line`/`character`); Go/TS/JS/Python/Rust/Ruby/Java when the server is installed |
| **tool_search** | Discover Deferred tools by query and reveal them for the rest of the session (`query`, optional `max_results`); keeps the default tool list small |
| **web_fetch** | Fetch a URL (SSRF-hardened: dial-time IP validation) |
| **web_search** | Provider-hosted web search (Anthropic `web_search_20250305` / Codex Responses-API `web_search_preview`). Server-side; not dispatched locally |
| **ask_user** | Ask the user a question and block for the answer (HITL; re-surfaced on reconnect) |
| **todo_write / todo_read** | Maintain a per-session task list |
| **Task** | Spawn a subagent (`internal/subagent`) |
| **skill** gateway | Invoke an in-memory skill |
| *(MCP)* | Tools from configured MCP servers (dynamic) |
| *(plugins)* | Tools/seams from WASM plugins |

**Tool interface** (`internal/tool/tool.go`):
`Name / Description / Schema(JSON Schema) / IsReadOnly / IsConcurrencySafe /
Exposure / Exec`. **ExecContext** carries `Executor` (sandbox), `Cwd`, `Env`,
`Spiller` (large-output spill), `MaxResultBytes`, `Asker` (HITL questions), and
`Shells` (background-shell registry).

Read-only file tools (`read/ls/glob/grep`) are `IsReadOnly` (usable in plan
mode) and `IsConcurrencySafe` (parallel within a turn). `bash` and the mutating
tools are fail-closed serial. Background processes started via `bash
run_in_background` are tracked per session and reaped on session end.

Philosophy: **Claude-Code-style first-class file tools + sandboxed bash**,
including background-process management — no longer shell-only.

---

## 5. Cross-agent matrix

| Capability | Claude Code | Codex | OpenCode | Carrier |
|---|:--:|:--:|:--:|:--:|
| Shell exec | Bash | shell / exec_command | shell | **bash** |
| Background shell | Bash(bg)+BashOutput+KillShell | exec_command | — | **bash(run_in_background)+bash_output+kill_shell** |
| Interactive shell (stdin) | — | write_stdin | — | **write_stdin** |
| Read file | Read | *(shell)* | read | **read** |
| Write file | Write | *(apply_patch)* | write | **write** |
| Edit (exact-match) | Edit | — | edit | **edit / multi_edit** |
| Patch envelope (multi-file) | — | apply_patch | apply_patch | **apply_patch** |
| File glob | Glob | *(shell)* | glob | **glob** |
| Content grep | Grep | *(shell)* | grep | **grep** |
| List dir | *(Glob/Bash)* | *(shell)* | read(dir) | **ls** |
| Subagents | Task | multi_agents / agent_jobs | task | **Task** |
| Todo / plan list | TodoWrite | update_plan | todowrite | **todo_write / todo_read** |
| Plan mode | ExitPlanMode | — | plan | *(planMode flag + read-only tools)* |
| Ask user | AskUserQuestion | request_user_input | question | **ask_user** (HITL) |
| Web fetch | WebFetch | — | webfetch | **web_fetch** |
| Web search | WebSearch | web_search | websearch | **web_search** (Anthropic/Codex hosted; OpenAI chat-completions drops it) |
| Image input | Read(image) | view_image | *(read)* | **view_image** (Anthropic + Codex + Gemini vision; OpenAI chat-completions text-degrades) |
| Notebook | NotebookEdit | — | — | **notebook_edit** |
| LSP diagnostics | *(via edits)* | — | **lsp** | **lsp** (diagnostics + hover; per-session servers) |
| Deferred-tool search | *(ToolSearch)* | tool_search | — | **tool_search** (reveals `Exposure.Deferred` tools, e.g. notebook_edit) |
| MCP resources | *(MCP)* | mcp_resource | *(MCP)* | *(MCP)* |
| Context-budget tools | — | get_context_remaining / new_context_window | — | — |
| Skills | *(skills)* | *(ext skills)* | skill | **skill** |

---

## 6. What Carrier is missing (and could adopt)

The first-class file/search/edit suite, HITL `ask_user`, and background-shell
management are **done**. Remaining gaps vs the reference agents:

| Gap | Who has it | Status / blocker |
|---|---|---|
| **context-budget tools** (`get_context_remaining` / `new_context_window`) | Codex | Runtime/harness concern — Carrier's Flight already compacts automatically (Summarizer/Checkpoint/ContextBudget); not a model-facing tool. |

The shell suite is complete (`bash` + `run_in_background` + `bash_output` +
`write_stdin` + `kill_shell`), `view_image` brings vision input, `lsp` adds
language intelligence, and `tool_search` activates the deferred-tool pool — so
the file/shell/web/vision/LSP/discovery surface now matches (and in places
exceeds) the reference agents.

**Recommended next:** essentially nothing at the tool layer — only the
context-budget tools remain, and those belong to the runtime (the Flight already
compacts automatically), not a model-facing tool.

**Note on tool_search** (`internal/tool/toolsearch.go`): the registry gained a
per-session "revealed" set — `Visible()` returns Direct tools plus any Deferred
tools revealed this session, and `Reveal(name)` flips a Deferred tool on.
`tool_search(query)` ranks the Deferred pool by query-term overlap (trivial
<3-char words ignored), reveals the matches, and lists them; they appear in the
model's tool list on the next turn with full schema. `notebook_edit` ships
Deferred as the first member of that pool — niche (Jupyter-only), so it stays out
of the default list and is recovered on demand. Dispatch resolves any registered
tool by name, so a revealed tool is immediately callable.

**Note on lsp** (`internal/lsp/`): a minimal LSP client (`client.go`: JSON-RPC
over stdio with Content-Length framing, the initialize/didOpen handshake, pushed
diagnostics, hover, and replies to server→client requests so real servers don't
stall) plus a per-session `Manager` that lazily spawns and reuses one server per
language (Go/TS/JS/Python/Rust/Ruby/Java), reaped on session end. The `lsp` tool
returns diagnostics by default or hover when given a line/character. A missing or
broken server degrades to a clear message (and the failure is cached, not retried
every call). The client is IO-decoupled so it's tested against an in-process mock
server — no language-server binary required in CI.

Hardened for real servers: the initialize handshake and hover requests are
time-bounded so a hung/slow server can't block a tool call indefinitely; a
re-checked file is synced with `didChange` (a bumped version), not a second
`didOpen`. Diagnostics are matched by document **version**: `Diagnostics` only
accepts a publish at the version it just sent or newer, so a late publish for a
superseded version (the server finishing analysis of old text after a change)
is rejected rather than returned as if fresh — and, symmetrically, a late
lower-version publish can't evict an already-stored newer one (the cache only
accepts a publish whose version is >= the one held). Together these close the
re-check staleness race for servers that report versions (gopls, tsserver,
pyright, …); servers that omit versions fall back to a best-effort cache-reset.
A wait that times out
is reported as "no diagnostics in time", distinct from a genuinely clean file.

**Note on view_image:** multimodal threads through the whole pipeline — the tool
returns image bytes on `tool.Result.Images`, which flow into `agent.ToolResult`/
`agent.Message` (`ImageData`), persist in the store's tool-result record, and the
Anthropic engine renders them as image blocks inside the `tool_result`; the Codex
(Responses API) engine — whose `function_call_output` is text-only — attaches
them as a following user message of `input_image` parts (base64 data URLs); and
the Gemini engine attaches them as a following user turn of inline-data parts
(the model rejects `function_response.parts`, confirmed live on Vertex). Because
history is rebuilt from the store each step, persisting the image
is what keeps it in context across turns. The OpenAI chat-completions engine has
no vision wiring yet, so it ignores the images and keeps the text ack.

**Note on the Gemini engine** (`internal/engine/gemini.go`): a native Google
adapter on the unified `google.golang.org/genai` SDK — one engine speaks both the
Gemini Developer API (`GEMINI_API_KEY`) and Vertex AI
(`GOOGLE_GENAI_USE_VERTEXAI=1` + project/location), resolved from the environment.
Selected with `CARRIER_AUTH=gemini`. Tool results correlate by function *name*
(looked up from the requesting call), and `view_image` images ride as a following
user turn of inline-data parts. `web_search` (GoogleSearch grounding) is dropped on Gemini —
it can't be combined with function calling in one request, and the function tools
are essential.

**Note on web_search:** implemented the Claude-Code/Codex way — a *provider-hosted
server tool*, not a local HTTP call. `agent.Tool.Native` marks it; each Engine
injects its native form (Anthropic `web_search_20250305`, Codex Responses-API
`web_search`) and the provider runs the search inline. OpenAI's chat-completions
engine can't host it, so it drops the tool rather than advertise a dead one.
There is no client `tool_call` event for it — results stream as ordinary
assistant text with citations.
