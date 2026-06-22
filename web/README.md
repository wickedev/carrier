# Carrier Web Client

The user-facing coding surface for [Carrier](../) — a full-stack TypeScript pnpm
monorepo: a React **IDE** web app plus a **BFF / control-plane**. Plan and design
live in [`.kiro/specs/web-client`](../.kiro/specs/web-client/).

- **GitHub SSO**; **Org-or-Personal → Project → Session** (a Project owns a
  persistent base workspace and optionally binds one GitHub repo; each Session
  runs in its own **isolated git worktree** forked from the base, so concurrent
  sessions never collide).
- **IDE split-view**: file tree · editor/diff · agent trace + chat, streamed
  live from the Carrier runtime over SSE relayed by the BFF.

## Layout

```
apps/web              React 19 + Vite + React Router v7 + Tailwind v4
                      + shadcn/ui (Base UI) + TanStack Query + CodeMirror 6
apps/bff              Hono + Drizzle/PGlite + Octokit + iron-session; brokers to
                      GitHub, the Carrier runtime (HTTP+SSE), and Postgres/PGlite
packages/contract     zod schemas + inferred types (single source of truth)
packages/carrier-client  typed Carrier HTTP+SSE client
packages/ui           shared shadcn-style components (Base UI) + tokens
```

## Develop

Requires Node 22+ and pnpm 11 (both available via asdf).

```sh
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm --filter @carrier/web build

# run both apps in dev
pnpm dev                 # turbo: web (5173, proxies /bff → 8787) + bff (8787)
```

The browser talks only to the BFF (httpOnly cookie session). The BFF holds all
GitHub and Carrier credentials. The web app's vite dev server proxies `/bff` and
`/auth` to the BFF.
