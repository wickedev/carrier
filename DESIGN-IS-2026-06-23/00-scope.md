# Design Is — Scope (2026-06-23)

## What is being audited
The **Carrier web app** — the user-facing coding-agent workspace.

- **Live target:** http://localhost:35173 (dev stack running; web 35173 / bff 38787 / carrier 39099). Dev login prefilled: `dev@carrier.local` / `carrierdev`.
- **Source:** `web/apps/web/src` (`routes/`, `components/`, `components/ide/`), shared primitives in `web/apps/web/src/components/primitives.tsx` and `web/packages/ui/src`.
- **Stack:** React 19 + Vite 6 + React Router v7 (library mode) + Tailwind v4 + shadcn/Base UI + TanStack Query + CodeMirror 6.

## Screens
1. `/login` — email/password (dev-prefilled) + GitHub SSO, login/register toggle.
2. Org / project list (`/:org`, index).
3. IDE session view — 3-pane: file tree | editor/diff (CodeMirror) | agent trace + chat composer + approvals + usage.
4. Settings — Org (members, GitHub installations, Configuration sections: model/context/agents/skills/MCP/hooks/env) and Project (repo binding, permissions, usage, danger zone, same Configuration sections).
5. Plugin Marketplace — browse + plugin detail (capabilities, seams) + install consent dialog + installed-plugins management.

Light + dark themes (theme toggle present).

## Primary user & task
- **Primary user:** a developer running concurrent server-side coding-agent sessions.
- **Primary task:** open a project → start/resume a session → drive the agent (send input, review tool calls/diffs, approve risky actions, promote/PR) in the IDE.

## Constraints
- Public repo, English-only UI copy. Tailwind/shadcn design system. MVP built by the main session (so candid self-critique expected).
- Accessibility floor: keyboard-reachable primary actions, visible focus, WCAG AA text contrast.

## Method
Source is the primary evidence (component file:line, Tailwind tokens, built bundle size). Rendered-pixel measurements that require a live browser are marked **INFERRED** where taken from source rather than computed styles.
