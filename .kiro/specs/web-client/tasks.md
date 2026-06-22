# Implementation Plan — Carrier Web Client

Incremental, test-driven tasks building the web app + BFF monorepo. Each task
references the requirements it satisfies (see `requirements.md`); the design is in
`design.md`. Phases are ordered so each builds on the previous.

## Phase 0 — Monorepo scaffold

- [ ] 1. pnpm + Turborepo workspace
  - `pnpm-workspace.yaml`, `turbo.json`, shared `packages/config` (tsconfig, eslint, prettier, tailwind preset). Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`.
  - _Requirements: 14.2, 18.1_
- [ ] 2. Contract package
  - `packages/contract`: zod schemas + inferred types for every endpoint and the `SessionEvent` union. Exported as the single source of truth.
  - _Requirements: 14.1, 14.2_
- [ ] 3. App skeletons
  - `apps/web` (Vite + React 19 + React Router v7 framework mode + Tailwind v4 + shadcn/ui Base UI init) and `apps/bff` (Hono + Node + Drizzle + Postgres connection). Health-check route end to end. `packages/ui` theme + base components.
  - _Requirements: 18.1, 18.2_

## Phase 1 — Authentication (GitHub SSO)

- [ ] 4. BFF auth
  - `@octokit/oauth-app` flow: `/auth/github`, `/auth/github/callback` (verify `state`), signed httpOnly cookie session (iron-session). First-login provisions Account + Personal org. `/auth/logout`. `/me` returns account + contexts.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 2.1_
- [ ] 5. Web auth integration
  - `/login` page; React Router loaders enforce auth and redirect with return-to; Org/Personal context switcher in the app shell; CSRF token on mutations.
  - _Requirements: 1.5, 2.2, 2.4_

## Phase 2 — Control-plane: orgs, projects, members

- [ ] 6. Data model + migrations
  - Drizzle schema for account/org/membership/project/workspace/session/permission_rule/github_installation/usage_rollup; migrations; seed/test fixtures.
  - _Requirements: 2.1, 3.1, 4.1_
- [ ] 7. Orgs & membership API + UI
  - `GET /orgs`, role-gated member management; reconcile GitHub org membership on sign-in; role matrix enforcement (owner/admin/member).
  - _Requirements: 2.1, 2.3, 2.4, 3.1, 3.2, 3.3_
- [ ] 8. Projects API + UI
  - CRUD + archive (`/orgs/:org/projects`, `/projects/:id`); project list page and overview; workspace provisioned on create.
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

## Phase 3 — GitHub App, workspace, Carrier brokering

- [ ] 9. GitHub App + repo binding
  - App install callback, list installations/repos (`/github/installations`); bind/unbind a project to one repo + default branch; installation tokens via `@octokit/auth-app` (server-side only).
  - _Requirements: 5.1, 5.2, 5.4, 17.2_
- [ ] 10. Project base workspace + per-session working copies
  - Provision the canonical **base** per Project on the shared volume (clone repo-bound with an installation token; unbound = git-init'd dir). On session start, fork an **isolated working copy**: `git worktree add` on a `carrier/<session>` branch (repo-bound) or a CoW / `cp -a` snapshot (unbound). Track per-working-copy git state; reset/re-sync; prune the worktree/overlay on session close. Guarantee concurrent working copies are mutually isolated and never mutate the base directly (closes the concurrent-session data-loss risk).
  - _Requirements: 5.3, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
- [ ] 11. Carrier client + session brokering
  - `packages/carrier-client`; on session create the BFF forks the working copy (task 10) and creates a Carrier session whose `cwd` is **that session's working copy** (not the base), with the Project permission rules; records `carrier_session_id`; session list/detail/archive (archive prunes the worktree).
  - _Requirements: 6.3, 7.1, 7.2, 7.3, 7.5, 12.3_

## Phase 4 — IDE shell + live streaming

- [ ] 12. SSE relay + session stream store
  - BFF `GET /sessions/:id/events`: hold upstream Carrier SSE, normalize to `SessionEvent` DTO, replay history then live, drop upstream on client disconnect. Web `SessionStream` store: ordered, `seq`-deduped event list, derived status, reconnect-with-backoff.
  - _Requirements: 7.4, 10.1, 13.1, 13.2, 13.3, 13.4_
- [ ] 13. Agent panel + composer
  - Streamed event log with structured tool-call/result cards; composer with steer/queue toggle; interrupt; running indicator. `POST /sessions/:id/input`, `/interrupt`.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_
- [ ] 14. File tree
  - `GET /sessions/:id/tree` over the session working copy (+ git status vs its branch); navigable virtualized tree; refresh on `file_changed` events; select-to-open.
  - _Requirements: 8.1, 8.2, 8.3, 8.4_
- [ ] 15. Editor / diff
  - `GET /sessions/:id/file` + `GET /sessions/:id/diff` (working copy vs base branch); CodeMirror 6 view with syntax highlighting + `@codemirror/merge` diff; live update on `file_changed`; large/binary file handling.
  - _Requirements: 9.1, 9.2, 9.3, 9.4_
- [ ] 16. IDE split-view assembly
  - Resizable three-pane layout (FileTree | EditorDiff | AgentPanel) with the TopBar breadcrumb and run controls; wire selection ↔ editor ↔ stream.
  - _Requirements: 8.4, 9.3, 10.5_

## Phase 5 — Approvals, permissions, plan mode

- [ ] 17. HITL approvals
  - Relay `approval_request` events; ApprovalCard approve/deny; `POST /sessions/:id/approvals/:reqId` correlates by ID and delivers the decision to Carrier; reflect timeout-denial.
  - _Requirements: 11.1, 11.2, 11.3, 11.4_
- [ ] 18. Permissions + plan mode
  - Project permission-rule editor (`/projects/:id/permissions`); start-session-in-plan-mode toggle; apply rules to created sessions.
  - _Requirements: 12.1, 12.2, 12.3_

## Phase 6 — Repo operations + usage

- [ ] 19. Promotion + branch / PR
  - `POST /sessions/:id/promote`: merge the session working copy into the Project base **serialized per Project** (base-mutation lock / transactional merge), or for repo-bound Projects push the `carrier/<session>` branch and open a PR instead of mutating the base in place; surface conflicts when the base advanced since the fork. Server-side branch/commit/push via installation token; surface branch + PR status in the TopBar with the PR link.
  - _Requirements: 6.8, 6.9, 15.1, 15.2, 15.3, 15.4_
- [ ] 20. Usage & cost
  - Pull Carrier usage/cost; per-session display in the IDE; per-project/org rollups.
  - _Requirements: 16.1, 16.2_

## Phase 7 — Settings, polish, quality

- [ ] 21. Settings
  - Org settings (members, installations) and project settings (repo binding, permissions, danger zone), role-gated.
  - _Requirements: 17.1, 17.2_
- [ ] 22. States, theming, a11y
  - Loading/empty/error states + error boundaries for every primary view; light/dark theme; keyboard nav + ARIA for primary flows; virtualization for high-volume streams and large diffs.
  - _Requirements: 18.1, 18.2, 18.3, 18.4_

## Phase 8 — Testing, CI, observability

- [ ] 23. Test suites
  - Contract tests (responses parse against zod); BFF unit/integration (auth/CSRF, role matrix, SSE relay reconnect/dedupe, path-traversal) with mocked GitHub + fake Carrier + ephemeral Postgres; web unit (SessionStream ordering/dedupe/approval correlation, loaders/guards); Playwright E2E (sign-in → project → bind → session → stream → approve → diff → promote; drop/reconnect resilience).
  - **Concurrent-session isolation:** two Sessions of one Project edit files simultaneously; assert their working copies and the Project base stay mutually uncorrupted, and that serialized promotion surfaces a base-advanced conflict instead of clobbering.
  - _Requirements: 1.6, 3.3, 6.4, 6.9, 9.x, 10.x, 11.2, 13.2_
- [ ] 24. CI + observability
  - CI: typecheck, lint, unit/integration, build, Playwright. Web telemetry + BFF structured logs/traces; redact secrets.
  - _Requirements: 14.3, 14.4_

## Cross-cutting dependencies / notes

- **Workspace topology:** BFF and Carrier share the workspace volume holding the
  per-Project base and per-Session working copies (chosen design). Concurrency
  safety comes from per-Session worktrees/overlays (task 10), not from the volume
  choice. If sharing a volume is unacceptable, switch to a Carrier session file
  API (see design Open Questions) — affects tasks 10, 11, 14, 15.
- **Carrier enhancement (optional):** monotonic live event IDs through Carrier's
  `sq`/event DTO would enable exact SSE reconnect dedupe (task 12); until then,
  dedupe leans on history `seq` + content.
- **Secrets:** GitHub and Carrier credentials live only in the BFF; never shipped
  to the browser (tasks 4, 9, 11, 19).
