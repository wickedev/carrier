# Design Document — Carrier Web Client

## Overview

A full-stack TypeScript pnpm monorepo delivering the Carrier coding surface: a
React web app (the IDE) and a BFF/control-plane that owns auth, the
Org/Project/Session model, GitHub integration, and brokering to the Carrier
runtime. The browser talks only to the BFF (single origin); the BFF is the only
component holding GitHub and Carrier credentials.

```
                         ┌──────────── BFF (Hono, TS) ───────────┐
  Browser ──cookie────▶  │ auth (GitHub OAuth)  control-plane    │ ──▶ Postgres
 (React/Vite IDE) ◀─SSE─ │ GitHub App (Octokit) session broker   │ ──▶ GitHub API
                         │ SSE relay  workspace fs               │ ──▶ Carrier (HTTP+SSE)
                         └───────────────────────────────────────┘ ──▶ workspace volume
```

Decisions baked in (from clarification): web **+ BFF** in one monorepo; **GitHub
App** with repo clone/branch/PR; **IDE split-view** UX; **persistent workspace
per Project**, optional repo binding, **1 Project : N Sessions**; streaming
**relayed through the BFF**.

## Monorepo layout

pnpm workspace + Turborepo. Stack note: React Router v7 (framework mode) is the
current major; the prompt's "v8" is read as "latest". Tailwind v4 + shadcn/ui
**Base UI** registry (`@base-ui-components/react`).

```
apps/
  web/                 React 19 + Vite + React Router v7 (framework mode)
                       Tailwind v4 + shadcn/ui (Base UI), TanStack Query,
                       CodeMirror 6 (editor + @codemirror/merge diff)
  bff/                 Hono + Node, Drizzle ORM (Postgres), Octokit (OAuth + App),
                       signed httpOnly cookie sessions, SSE relay
packages/
  contract/            zod schemas + inferred TS types for every BFF endpoint and
                       SSE event — the single source of truth shared by web + bff
  carrier-client/      typed client for the Carrier HTTP+SSE API
  ui/                  shared shadcn/ui (Base UI) components + theme tokens
  config/              shared eslint / tsconfig / tailwind preset
pnpm-workspace.yaml · turbo.json · .github/workflows/ci.yml
```

## Stack rationale

- **Hono (BFF):** small, type-safe, first-class streaming (SSE relay), runs on
  Node; pairs with the `contract` zod package for end-to-end types.
- **Drizzle + Postgres:** typed schema in the monorepo, simple migrations.
- **Octokit:** `@octokit/oauth-app` (SSO) + `@octokit/auth-app` (installation
  tokens for repo ops).
- **React Router v7 framework mode:** file-based routes, loaders/actions for the
  control-plane data (orgs/projects/sessions); SSR for the app shell, client for
  the live IDE.
- **TanStack Query:** server-state cache for lists/file-tree; the live agent
  stream is handled by a dedicated event store (not Query).
- **CodeMirror 6:** lighter than Monaco, with `@codemirror/merge` for diffs;
  Monaco is the documented alternative if richer editing is needed.

## Authentication & GitHub

Two GitHub surfaces, both server-side:

1. **SSO (identity)** — OAuth Authorization Code flow via `@octokit/oauth-app`.
   On callback the BFF verifies `state`, exchanges the code, fetches the GitHub
   user + orgs, upserts the Account and contexts, and sets a signed httpOnly
   session cookie. No GitHub token reaches the browser.
2. **Repo access** — a **GitHub App**. The user installs it on an org/account;
   the BFF stores the `installation_id` and lists accessible repos. Repo ops
   (clone/branch/commit/push/PR) use short-lived **installation tokens** minted
   on demand via `@octokit/auth-app`, used server-side only.

Session: signed, httpOnly, `SameSite=Lax`, secure cookie (e.g. iron-session).
CSRF: OAuth `state`; mutating BFF routes require same-site cookies + an
anti-CSRF token on non-idempotent requests.

## Data model (Postgres / Drizzle)

```
account(id, github_user_id, login, name, avatar_url, email, created_at)
org(id, kind: 'org'|'personal', github_org_id?, slug, name, owner_account_id, created_at)
membership(account_id, org_id, role: 'owner'|'admin'|'member')
github_installation(id, installation_id, org_id, account_login, suspended, created_at)
project(id, org_id, slug, name, archived, workspace_id,
        repo_full_name?, repo_default_branch?, installation_id?, created_at)
workspace(id, project_id, root_path, repo_bound bool, status, last_synced_at)
session(id, project_id, carrier_session_id, title, status, created_by, created_at, archived)
permission_rule(id, project_id, action, pattern, effect: 'allow'|'deny'|'ask', source)
usage_rollup(scope: 'session'|'project'|'org', scope_id, input, output, cache_read, cache_write, cost)
```

Authorization is enforced in the BFF against `membership` for every request; the
web app never queries the DB.

## Carrier integration

The BFF is the only Carrier client. Mapping concerns:

- **Tenancy.** Carrier authenticates tenants by bearer token. The BFF holds a
  privileged Carrier service token and enforces Org/Project isolation itself in
  Postgres (a Carrier session is created by the BFF and recorded against a
  Project). (Per-org Carrier tokens are an alternative if Carrier later supports
  token minting.)
- **Session create.** `POST /v1/sessions` on Carrier, configured with the
  Project workspace path as the session's working directory and the Project's
  permission rules; the returned `carrier_session_id` is stored on `session`.
- **Workspace.** The **BFF owns the workspace filesystem** (a per-Project
  directory on a shared volume): it provisions/clones it and serves the
  file-tree/file/diff APIs by reading it directly. Carrier sessions run with that
  directory as their sandbox `cwd`, so edits land in the same place. **Deployment
  constraint:** BFF and Carrier share the workspace volume (co-located host or
  network filesystem). *Open decision:* alternatively Carrier exposes file APIs
  and owns the workspace — see Open Questions.
- **Streaming.** The web app opens `GET /bff/sessions/:id/events` (SSE); the BFF
  holds the upstream Carrier SSE (`GET /v1/sessions/:cid/events`), normalizes each
  event into the contract DTO, and relays. Input/steer/interrupt POST to the BFF,
  which forwards to Carrier (`POST /v1/sessions/:cid/input`).
- **HITL.** Carrier surfaces approval requests on the event stream; the BFF
  relays them as `approval_request` events and exposes
  `POST /bff/sessions/:id/approvals/:reqId` to deliver the decision back to
  Carrier's control channel.

## BFF API (contract)

REST (all under `/bff`, cookie-authenticated; types in `packages/contract`):

```
GET    /me                                 account + contexts
GET    /orgs                               list orgs/personal
GET    /orgs/:org/projects                 list projects
POST   /orgs/:org/projects                 create project (+ provision workspace)
GET    /projects/:id                       project detail (+ repo/workspace status)
POST   /projects/:id/bind                  bind repo (installation + repo + branch)
DELETE /projects/:id/bind                  unbind
GET    /projects/:id/tree?path=            workspace file tree (+ git status)
GET    /projects/:id/file?path=            file contents
GET    /projects/:id/diff?path=            diff vs base (for agent edits)
GET    /projects/:id/sessions              list sessions
POST   /projects/:id/sessions              create session (planMode?, title)
GET    /sessions/:id                       session detail
POST   /sessions/:id/input                 { text, steer }
POST   /sessions/:id/interrupt
GET    /sessions/:id/events                SSE stream (history replay + live)
POST   /sessions/:id/approvals/:reqId      { allow }
GET    /projects/:id/permissions           list/edit permission rules
GET    /github/installations               list installations + repos
POST   /github/app/callback                GitHub App install callback
GET    /auth/github / /auth/github/callback / POST /auth/logout
```

SSE event DTO (one canonical shape mirroring Carrier's StreamEvent):

```ts
type SessionEvent =
  | { seq: number; kind: 'text' | 'reasoning'; text: string }
  | { seq: number; kind: 'tool_call'; name: string; input: unknown; id: string }
  | { seq: number; kind: 'tool_result'; id: string; content: string; isError: boolean }
  | { seq: number; kind: 'file_changed'; path: string; status: 'A'|'M'|'D' }
  | { seq: number; kind: 'approval_request'; reqId: string; tool: string; resource: string; reason: string }
  | { seq: number; kind: 'status'; state: 'running'|'idle'|'terminated' }
  | { seq: number; kind: 'error'; message: string }
```

`file_changed` lets the IDE refresh the tree/diff without polling.

## Frontend architecture (apps/web)

Routes (React Router v7 framework mode):

```
/                         → redirect to active context or onboarding
/login                    GitHub SSO
/:org                     project list (Org/Personal switcher in the shell)
/:org/settings            members, GitHub installations
/:org/:project            session list + project overview
/:org/:project/settings   repo binding, permissions, danger zone
/:org/:project/s/:session IDE split-view (the main coding surface)
```

The IDE route is the heart (Requirement 8–10). Component tree:

```
SessionPage
├─ TopBar           breadcrumb (Org ▸ Project ▸ Session), branch/PR, run controls
├─ SplitLayout (resizable panes)
│  ├─ FileTree      workspace tree + git-status badges; selects a file
│  ├─ EditorDiff    CodeMirror 6 view/diff of the selected file; live updates
│  └─ AgentPanel    streamed event log (text/reasoning/tool cards) + composer
│     ├─ EventList  structured cards per SessionEvent kind
│     ├─ ApprovalCard  approve/deny for approval_request events
│     └─ Composer   message input + steer/queue toggle + interrupt
```

State management:

- **Route data** (orgs, projects, sessions, project detail): React Router
  loaders + TanStack Query for caching/invalidation.
- **Live session stream:** a dedicated `SessionStream` store (zustand or a
  reducer) fed by an `EventSource` to `/bff/sessions/:id/events`. It maintains an
  ordered event list deduped by `seq`, the derived run status, and pending
  approvals. On reconnect it relies on BFF history replay + `seq` dedupe
  (Requirement 13).
- **File/diff:** TanStack Query keyed by `(project, path, rev)`; invalidated by
  `file_changed` stream events so the open file/tree refresh near-real-time.
- **Optimistic input:** sending a message appends a local user event immediately;
  reconciled when the BFF echoes it.

UI system: shadcn/ui Base UI components + Tailwind v4 tokens in `packages/ui`;
light/dark via CSS variables; resizable panes; virtualized EventList and
FileTree for high-volume streams/large repos (Requirement 18.4).

## Security model

- Browser holds only the httpOnly session cookie — never GitHub/Carrier tokens.
- All authorization in the BFF against `membership`; tenant/project isolation
  enforced server-side (Carrier service token is privileged, so the BFF is the
  trust boundary).
- Installation tokens minted on demand, short-lived, never logged or returned.
- File/tree/diff APIs validate `path` against the project workspace root (no
  traversal). Workspace volume is per-Project; cross-project access is impossible
  via the API.
- SSE relay drops the upstream connection when the client disconnects.

## Testing strategy

- **Contract:** zod schemas in `packages/contract` are the single source; BFF
  handlers validate in/out against them; web uses inferred types. A contract test
  asserts BFF responses parse against the schemas.
- **BFF unit/integration:** Vitest; GitHub mocked via `msw`/nock; Carrier mocked
  via a fake SSE server; Postgres via testcontainers or an ephemeral schema. Auth
  (OAuth state/CSRF), authorization (role matrix), SSE relay (reconnect/dedupe),
  path-traversal guards.
- **Web component/unit:** Vitest + Testing Library; the `SessionStream` reducer
  (ordering, dedupe, approval correlation); FileTree/EditorDiff rendering;
  loaders/guards with `msw`.
- **E2E:** Playwright over a seeded BFF + fake Carrier: sign-in → create project →
  bind repo (mock) → start session → stream events → approve a request → see a
  diff. Streaming resilience: drop/reconnect mid-stream and assert no lost/dup
  events.
- **CI:** typecheck, lint, unit/integration, build, Playwright (headless).

## Open questions / decisions to make

- **Workspace ownership:** BFF-owns-filesystem + shared volume (chosen) vs Carrier
  exposes file/tree/diff APIs (removes the shared-volume constraint, adds Carrier
  surface). Affects deployment topology.
- **Live event IDs:** Carrier history records carry a `seq`; live events do not
  yet. Exact reconnect dedupe wants a monotonic per-session live event ID plumbed
  through Carrier's `sq`/event DTO (a small Carrier enhancement).
- **Concurrent editing by the user:** read-only editor first (agent edits only)
  vs user-editable workspace files (adds conflict handling with agent writes).
- **SSR depth:** framework-mode SSR for shell/lists vs SPA; the IDE is
  client-only regardless.
- **Carrier multi-tenancy:** BFF service token + BFF-enforced isolation (chosen)
  vs per-org Carrier tokens (needs Carrier token minting).
