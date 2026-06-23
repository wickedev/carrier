# Design Is — Evidence (2026-06-23)

Consolidated from five evidence subagents (structural, visual, copy & honesty, weight & friction, accessibility). Source-read; rendered-pixel claims marked INFERRED.

## Structural (feeds #2, #4, #5, #10)
- **Interactive density per surface:** login 6; org list 4; IDE session view ~17 distinct controls (`session.tsx`, `components/ide/*`); **Project settings + ConfigSections ~50+ controls** (densest static surface — `settings.tsx`, `config-sections.tsx:857` renders 7 sub-sections each with form + per-row toggle + delete); marketplace ~14 across 3 views.
- **Max nesting depth:** IDE ≈ 11 component/JSX levels route→leaf (`session.tsx:128` → IdeLayout → PanelGroup → Panel → AgentPanel → … → Card → Button). FileTree recursion is **unbounded** (`FileTree.tsx:95,137`, +1 indent level per dir depth).
- **Repeated patterns (6):** (1) **Card+add-form+list "section" — 8 near-identical instances** (`config-sections.tsx:137,252,370,468,570`; `settings.tsx:91,349`; `marketplace.tsx:565`). (2) Delete/trash button factored as `DeleteButton` (`config-sections.tsx:63`) but **re-inlined 4×** (`settings.tsx:133,414`; `marketplace.tsx:597`). (3) EnableToggle factored (`config-sections.tsx:37`) but re-inlined (`marketplace.tsx:586`). (4) Divergent status indicators: `StatusIcon` (`project.tsx:10`) vs `StatusDot` (`TopBar.tsx:18`). (5) Spinner-or-icon-in-Button inlined ~9× instead of using the `Spinner` primitive. (6) Breadcrumb header repeated 4× with a richer 5th variant.
- **Dead/unreachable (4):** `projectName` prop always `undefined` (`session.tsx:133` → `TopBar.tsx:88`); **`InstallConsentDialog` scope-select is dead UI** — only `orgScope` is ever passed, so the `scope==="project"` branch + `<select>` (`marketplace.tsx:438-451`) is unreachable (install is always org-scoped); `destructive` Button variant defined (`button.tsx:13`) never used; 3 `exhaustive-deps` suppressions.
- **Removable candidates:** decorative "or" divider (`login.tsx:126-130`); dead scope select; `projectName` prop; unused `destructive` variant; redundant on/off **text** label beside every toggle (`config-sections.tsx:57`, ~6 sections × N rows); duplicated status component; single-child flex wrapper (`marketplace.tsx:174-176`).

## Visual (feeds #3, #5, #8)
- **No design tokens** — `index.css`/`styles.css` only `@import "tailwindcss"` + dark variant; the whole system is **default Tailwind utilities used inline** (convention-only, unenforced).
- **Spacing:** disciplined ~4px grid, concentrated on 8/16px (`gap-2`×43, `mb-4`×31); low-frequency one-off margins (`mb-6`,`mt-8`,`ml-6`,`pl-9`).
- **Type:** tight scale 12/14/18px (`text-sm` 14px is the body default, ×119; `text-xs` ×49). Outliers: one `text-2xl` (login splash) and arbitrary `text-[11px]` (`UsagePanel.tsx:35`, `EventList.tsx:90`). **Heading hierarchy is flat** — page H1/H2 are nearly all `text-lg`.
- **Color:** single neutral ramp + 4 accents (red/blue/green/amber) — **hue-disciplined** (no gray/zinc/slate mixing); primary is monochrome (`bg-neutral-900`/`dark:bg-neutral-100`, `button.tsx:10`). But **shade discipline is loose** (amber spans 11 shades, blue 9, red 8; ~60+ distinct color-shade refs + 26 `dark:` variants).
- **States:** empty ✓ (`EmptyState`), loading ✓ (`Loading`/`Spinner`), error ✓ (`ErrorState` + Retry), focus ✓ (`focus-visible:ring-2` on Button/Input), disabled ✓ (`disabled:opacity-50`). **Success ✗ — no success/confirmation feedback after writes**; mutations silently reset/navigate (`settings.tsx:88,346,477`).

## Copy & honesty (feeds #4, #6)
- **Inflations: NONE.** No "powerful/blazing/seamless/magic"; descriptive throughout — a notably honest copy deck.
- **Dark patterns: NONE; consent dialog exemplary.** `permissions.allow` opt-in **defaults OFF** (`marketplace.tsx:404`) with amber `ShieldAlert` warning + "Off by default — only tick if you trust it" (`:521`); only honored if the manifest requested it (`:417`). Capability grants individually visible/deselectable with "anything you leave unchecked will be denied at runtime" (`:435`). Two-step archive confirm (`settings.tsx:491-505`). (Minor: env "secret" checkbox defaults OFF → cleartext-by-default; honest but safer reversed.)
- **Jargon (multiple, audience is developers but still opaque):** "Promote" (`TopBar.tsx:130`), "Steer"/"Queue" with the only explanation in a code comment (`Composer.tsx:8-9,57,70`), "Seams" + raw `SeamKind` badges (`marketplace.tsx:309,313`), bare `manifestDigest` hash (`:244`), "permission_ask"/"permissions.allow" dot-paths (`:294,519`), "MCP servers" unexpanded (`config-sections.tsx:372`), "Plan mode" (`project.tsx:83`), "working copy" dirty-dot with no tooltip (`TopBar.tsx:100`), "Effort … xhigh/max" (`config-sections.tsx:744`), git **A/M/D/U** badges with **no legend** (`FileTree.tsx:16-22`). (Fleet metaphor Bay/Flight/Tower does NOT leak into the UI — good.)
- **Label→behavior mismatch (1):** **"Promote"** (with a `GitPullRequest` icon) calls `api.promote()` which either **opens a PR** OR **merges directly to base** (`session.tsx:96-115`) — two materially different consequences (one reviewable, one not) behind one control, disclosed only *after* the click via a status chip. All other labels verified to map 1:1 (Steer/Interrupt/Approve/Deny/Archive/Bind/etc.).

## Weight & friction (feeds #9)
- **Bundle: 936.71 kB raw / 293.09 kB gzip, SINGLE chunk, no code-splitting** (vite v6.4.3 output; vite warned >500kB). No `React.lazy`/dynamic import anywhere — the **login screen ships the full CodeMirror+IDE bundle**.
- **Primary-view requests:** ~4 on load (session GET, usage GET [polls every 15s], file-tree root GET, 1 SSE EventSource), rising to 6 after first file selection (`session.tsx:25,28,52`; `FileTree.tsx:70`; `queries.ts`). 
- **TTI:** ~0.9–1.5s estimate on localhost (no SSR, full-bundle parse + React 19 hydration).
- **Idle animation:** 0–1 (a running-status spinner, `TopBar.tsx:22`); **`prefers-reduced-motion` NOT respected anywhere**.
- **Badges/modals on load:** ~3 always-on TopBar pills (usage/connection/status) + branch pill; 0 toasts (no toast system), 0 modals on load (consent dialog is user-triggered).
- **Dark mode:** honored via class strategy + localStorage + `matchMedia` (`theme.ts`), but **applied after hydration → FOUC** (no inline head script; `index.html` only loads `main.tsx`).

## Accessibility (feeds #2, #4)
- **Keyboard: 100% of primary actions are real `<button>/<a>/<input>/<select>` — zero `div/span onClick`.** Fully keyboard-reachable.
- **Contrast (INFERRED, AA 4.5 normal / 3.0 large):** **`text-neutral-400` ≈ 2.55–2.8:1 on light — FAILS**, used widely for secondary labels/placeholders/icons/status (`UsagePanel.tsx:35`, `Composer.tsx:44`, `TopBar.tsx:27`, `FileTree`). **`text-red-500` ≈ 3.8:1 on light — FAILS** for normal-size inline form errors (config-sections create-errors). **`text-neutral-500` ≈ 4.5:1 — borderline** (the app's default body color, 14px). Dark mode generally passes.
- **Focus rings:** present on shared Button/Input; **MISSING app-level ring on FileTree toggle/select, Composer Queue/Steer, `DeleteButton`, all `<select>`, OrgSwitcher options** (rely on UA default outline only).
- **Live region:** **the streaming SSE agent output has no `aria-live`/`role="log"`** (`AgentPanel.tsx:43`) — screen-reader users get no announcement of agent text/tool output (only errors are `role="alert"`).
- **Landmarks:** `<header>`/`<main>`/`<nav aria-label="Breadcrumb">` present; **no skip-link**, `<main>` has no `id` target; IDE panes are unlabeled (no `<aside>`/region roles). 63 aria-labels overall; icon-only buttons are labeled.

## Known gaps
Source-only (app at :35173 not pixel-inspected); contrast/TTI are INFERRED/estimated; server-side error strings (rendered raw via `(error as Error).message`) not inventoried; `@carrier/ui`/`@carrier/contract` internals and `api/*`/`stream.ts` not fully read; bundle composition inferred from imports, not an analyzer.
