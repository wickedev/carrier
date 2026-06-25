# Carrier — Industrial Redesign: Phased Implementation Plan

> Execution plan for the approved Industrial / terminal redesign. Each phase is
> self-contained for a fresh chat context. Author with `make-plan`, execute with
> `do`.
>
> **Primary references (read before any phase):**
> - Design system spec: `DESIGN-TASTE-2026-06-25/DESIGN-SYSTEM-industrial.md`
> - Approved visual comp: `design-mockups/industrial.html`
> - Taste audit (what already shipped): `DESIGN-TASTE-2026-06-25/audit.md`
>
> Build on branch `design-taste-tokens` (already carries the semantic token layer,
> `.focus-ring`, toast hardening, Composer dedup), or branch from it.

---

## Phase 0 — Discovery (consolidated facts / constraints)

These are verified from the codebase. Treat as the "Allowed APIs / Reality" list.

### Layout reality
- **Narrow centered column to remove** = `mx-auto max-w-3xl p-6`, at:
  `routes/org.tsx:16`, `routes/project.tsx:37`, `routes/settings.tsx:40` & `:201`,
  `routes/marketplace.tsx:60`.
- IDE screen `routes/session.tsx:141` = `flex h-full flex-col` → `TopBar` +
  `IdeLayout`. Not centered (leave full-bleed; restyle in place).
- 3-pane = `components/ide/IdeLayout.tsx:20-35`, `PanelGroup` (react-resizable-panels),
  panels 18% / 52% / 30%; handle color `bg-neutral-200 dark:bg-neutral-800`,
  hover `bg-blue-400`, drag `bg-blue-500`.
- App shell header = `components/Shell.tsx:100` (`px-4 py-2`), main `Shell.tsx:119`
  (`min-h-0 flex-1`).
- Login = `routes/login.tsx:58` full-screen center, `w-72` form; OAuth link styled
  via `buttonVariants` (`login.tsx:21`).

### Design-system infra
- Tailwind **v4** via `@tailwindcss/vite` (`vite.config.ts:3,13`); **no config file**.
  All tokens live in `src/index.css` (`@import "tailwindcss"` + `@theme` blocks +
  `@layer components`).
- **Radius:** `rounded-md`/`rounded-lg` resolve to `--radius-md`/`--radius-lg`.
  Redefining these in `@theme` flips ALL `rounded-*` globally — no per-file edits
  for the 17 occurrences. `rounded-full` (avatar `Shell.tsx`) is unaffected.
- **Fonts:** none self-hosted (system stack only). No `public/` dir. Use
  **Fontsource** npm packages (Vite-native, satisfies "no `<link>`" rule).
- **`@carrier/ui`** (`web/packages/ui/`) exports `Button`, `buttonVariants`,
  `ButtonProps`, `cn`. Used ONLY by `web/apps/web` (not bff). `Button` base has
  `rounded-md` and default variant `bg-neutral-900 text-white`. **Convention:
  do NOT edit `packages/ui`** (`primitives.tsx:5`). Override at the app layer.
- Semantic tokens already exist (`index.css`): `--success/--warning/--info/
  --untracked/--danger`, plus `--fg/--fg-muted/--fg-subtle`. `.focus-ring`
  utility exists.

### Hard constraints (anti-pattern guards, apply to EVERY phase)
1. **Do not edit `web/packages/ui/`.** Override radius via tokens; override primary
   color via `className` / app wrapper at call sites.
2. **Preserve every `data-testid` and `aria-*`/`role`.** Tests depend on:
   `promote-status`, `pr-link`, `approval-card`, `approval-expired`,
   `agent-scroll`, `event-list`, `model-params-section`, etc. Grep before/after.
3. **No raw semantic color utilities.** Use `text-success/-warning/-info/
   -untracked/-danger` + new `--accent`. Do not reintroduce `text-green-600` etc.
4. **No CRT scanlines / halftone / global noise / clamp() bleed numerals.**
   (Skill decoration that hurts an IDE — see DESIGN-SYSTEM §0.)
5. **Keep accessibility wins:** focus-visible rings, `motion-reduce`, reduced-motion,
   keyboard reachability, toast `aria-live`.
6. Run `pnpm typecheck && pnpm test && pnpm build` at the end of every phase.

---

## Phase 1 — Foundation: tokens, fonts, radius, base

**Goal:** the global look flips to industrial without touching screens yet.

**What to implement** (`web/apps/web/src/index.css`, and `package.json`):
1. Add chrome + accent tokens (copy values from DESIGN-SYSTEM §1.2):
   `--bg #080808`, `--panel #0e0e0e`, `--line #242424`, `--accent #f59e0b`,
   `--accent-fg #000`; remap `--fg #e6e6e6`, `--fg-muted #8c8c8c`,
   `--fg-subtle #5a5a5a`. Expose via `@theme inline` as `--color-bg/-panel/-line/
   -accent/-accent-fg`. Set `body { background: var(--bg); color: var(--fg) }`.
2. **Radius 0:** in `@theme`, set `--radius-sm/-md/-lg/-xl: 0` (and `--radius: 0`).
   Verify `rounded-full` avatar still round.
3. **Recolor focus ring** to amber: `.focus-ring:focus-visible { @apply outline-none
   ring-2; box-shadow: 0 0 0 2px var(--accent) }` (or `ring-[--accent]`).
4. **Fonts via Fontsource:** `pnpm add @fontsource/jetbrains-mono @fontsource-variable/space-grotesk`
   (verify exact package names at install). Import in `main.tsx`. Add to `@theme`:
   `--font-mono: "JetBrains Mono", ...; --font-sans: "JetBrains Mono", ...` (mono is
   the default body font) and a `--font-display: "Space Grotesk", sans-serif`.
   Apply `font-family: var(--font-mono)` on `body`.
5. Grid-rule background utility (lists only): add a `.grid-rule` component class
   copying the `linear-gradient` from `industrial.html` `<style> .grid-bg`.

**Doc references:** DESIGN-SYSTEM §1; `industrial.html` `<style>` block (`:root`,
`.grid-bg`, `::selection`); current `index.css:1-48`.

**Verification:**
- `pnpm build` ok; grep compiled CSS for `--color-accent`, `font-mono` JetBrains.
- App renders near-black with mono font, square corners, amber focus rings.
- `pnpm typecheck && pnpm test` green.

**Anti-pattern guards:** don't hand-edit the 17 `rounded-*` sites; don't add a
`<link>` font; keep light-mode `:root` valid (industrial is dark-first — set
`.dark` and `:root` to the same dark values for now, or default `.dark` on).

---

## Phase 2 — Shared primitives

**Goal:** rebuild the reusable building blocks so screens inherit the look.

**What to implement** (`components/primitives.tsx`, `components/config-controls.tsx`,
primary-button strategy):
1. **`Card` → industrial `Panel`:** replace `rounded-lg border bg-white shadow-sm`
   with `border border-[--color-line] bg-[--color-panel]` (no radius, no shadow).
   Keep the `Card` export name to avoid churn, OR add `Panel` + alias.
   (`primitives.tsx:11-24`)
2. **`Badge`:** drop fill; bold uppercase, color via prop. (`primitives.tsx:26-39`)
3. **`Toggle`:** square segmented; active = amber underline (subtle) / amber fill
   (solid). (`primitives.tsx:84-134`)
4. **`Input`:** transparent, 1px `--line`, radius 0, focus border amber.
   (`primitives.tsx:136-149`)
5. **`Loading/EmptyState/ErrorState`:** terse, uppercase labels; ErrorState Retry
   already `text-info`. (`primitives.tsx:151-210`)
6. **`CardHeader`:** uppercase tracking strip; keep `tone` amber/neutral.
7. **Primary button (amber):** primary CTAs apply
   `className="bg-[--color-accent] text-[--color-accent-fg] hover:brightness-110"`
   (Button keeps radius 0 via tokens). Apply at call sites in later phases; define
   an app helper `primaryBtn` class in `index.css` to avoid repetition.
8. `config-controls.tsx`: `DeleteButton`, `EnableToggle`, `ConfigSection` (Card→Panel,
   uppercase section header).

**Doc references:** DESIGN-SYSTEM §2 (component table); `industrial.html` button /
list-row / panel / input markup; current `primitives.tsx`, `config-controls.tsx`.

**Verification:** `pnpm test` (primitives covered by route tests) green; visually
diff a settings Card vs comp panel; grep no `shadow-sm`/`rounded-lg` left in
primitives.

**Anti-pattern guards:** keep `forwardRef` on Card/Input; keep `aria-pressed`,
`aria-label`s; don't change component prop signatures (tests + callers depend).

---

## Phase 3 — List screens (Projects, Sessions)

**Goal:** kill the narrow column; full-width divided lists with density.

**What to implement** (`routes/org.tsx`, `routes/project.tsx`):
1. Replace `mx-auto max-w-3xl p-6` → full-width wrapper with `.grid-rule` bg and an
   inner `mx-auto max-w-6xl px-6 py-8` content frame anchored top.
   (`org.tsx:16`, `project.tsx:37`)
2. Header: title in display font + uppercase sub-meta; actions right (Settings
   secondary + amber primary). Copy from `industrial.html` `#projects` / `#sessions`.
3. Rows: replace `space-y-2` Card list with a `divide-y border-y` full-width list;
   leading index (`01/02`), hover `bg-neutral-900`, trailing `→`. Sessions get a
   column-header row (`#/Title/Status/Created`).
4. Status: use `StatusDot`/pill primitives (info=idle, success=running).

**Doc references:** `industrial.html` `#projects` and `#sessions` sections (exact
markup to copy); DESIGN-SYSTEM §2-3; `org.tsx`, `project.tsx` current structure
from Phase 0.

**Verification:** `pnpm test` (`org.test.tsx` passes — keep testids/labels);
manual: no giant side margins; rows dense, divided, hoverable; keyboard tab order
intact.

**Anti-pattern guards:** keep New project/session one-click behavior; keep
breadcrumb links + `aria-label="Breadcrumb"`; don't drop the empty/loading/error
branches.

---

## Phase 4 — IDE shell

**Goal:** the session view reads as a tactical workbench, populated-first.

**What to implement:**
1. **`TopBar.tsx`:** uppercase breadcrumb, mono branch chip (1px, radius 0), status
   pills (tokens), amber primary `Merge/Open PR`. Keep `data-testid` `promote-status`,
   `pr-link`. (`TopBar.tsx:87-193`)
2. **`IdeLayout.tsx`:** recolor handles `bg-[--color-line]`, hover/drag `bg-[--color-accent]`
   (replace blue). Panes separated by 1px. (`IdeLayout.tsx:20-35`)
3. **Pane header strips:** add uppercase `tracking` header to FileTree / Editor /
   AgentPanel panes (copy from comp).
4. **`FileTree.tsx`:** square rows, amber folder/active, semantic git badges
   (already tokenized). Keep indentation logic + roles.
5. **`EditorDiff.tsx`:** square File/Diff toggle; mono path; 1px header.
6. **`EventList.tsx` / `AgentPanel.tsx`:** square panels, uppercase kind labels,
   keep `role="log"`, `data-testid="agent-scroll"/"event-list"`.
7. **`Composer.tsx`:** square segmented Queue/Steer (amber active), square textarea
   (focus amber), amber send. Keep tooltips (helper already removed).
8. **`UsagePanel.tsx`:** mono pill, 1px, radius 0.

**Doc references:** `industrial.html` `#session` (topbar + 3-pane + composer markup);
DESIGN-SYSTEM §2-3; Phase 0 IDE facts.

**Verification:** `pnpm test` (ApprovalCard, AgentPanel, UsagePanel tests pass);
manual: open a session, confirm 3-pane 1px compartments, amber handles, populated
states legible; reduced-motion still gated.

**Anti-pattern guards:** preserve ApprovalCard `role="alertdialog"` + focus move +
`approval-card`/`approval-expired` testids; keep resize autosave id `carrier-ide`;
don't put scanlines/grid bg behind editor or stream.

---

## Phase 5 — Settings, marketplace, login, config-sections

**Goal:** apply the system to the remaining surfaces.

**What to implement:**
1. `settings.tsx` (org + project): full-width frame (drop `max-w-3xl`), Panel
   sections, uppercase headers, Danger zone uses `--danger` (done) + square.
   (`settings.tsx:40,201`)
2. `marketplace.tsx`: full-width; plugin grid → bordered grid (`gap:1px` rule);
   square cards; keep `InstallConsentDialog` (square it). (`marketplace.tsx:60,88`)
3. `config-sections.tsx`: Panel sections via updated `ConfigSection`; square inputs.
4. `login.tsx`: keep centered; restyle to mono/square; OAuth link via `buttonVariants`
   + amber `className`; theme toggle square. (`login.tsx:21,58`)
5. `Shell.tsx` header: mono wordmark, 1px bottom, square org switcher.

**Doc references:** DESIGN-SYSTEM §2-3; current files from Phase 0; comp top bar.

**Verification:** `pnpm test` (`settings.test.tsx`, `marketplace.test.tsx`,
`config-sections.test.tsx` pass); manual sweep each route in dark mode.

**Anti-pattern guards:** keep form field names/order (analytics/autofill); keep
modal `role`/focus; keep `buttonVariants` usage in login (don't inline-duplicate).

---

## Phase 6 — Verification & polish

1. **Automated:** `pnpm typecheck && pnpm test && pnpm build` all green; grep dist
   CSS for accent/font tokens; grep src for leftover `rounded-lg`/`shadow-sm`/raw
   `text-(green|blue|amber|violet|red)-[0-9]` (should be only intentional surface
   tints) and any reintroduced semantic colors.
2. **Contrast audit:** amber `#f59e0b` and each semantic token on `#080808` ≥ WCAG
   AA for their text role; fix any failures by nudging the dark token.
3. **A11y regression:** keyboard tab every screen; `prefers-reduced-motion` kills
   the running-dot pulse; focus rings visible (amber).
4. **Visual diff:** screenshot each redesigned screen vs `industrial.html` tab.
5. **Review:** run `/code-review` on the branch; address findings.
6. **Docs:** update `audit.md` implementation log; optionally emit a `DESIGN.md`
   via `stitch-design-taste` to codify the shipped system.

---

## Execution status (2026-06-25, branch `design-taste-tokens`)

All phases executed via `do` (subagent per phase, orchestrator verified + committed).

| Phase | Commit | Result |
|---|---|---|
| baseline (token prework) | `3763788` | semantic tokens, focus-ring, toast |
| 1 Foundation | `3e31783` | chrome+accent tokens, radius 0, Fontsource fonts |
| 2 Primitives | `594b972` | Panel/Toggle/Input/Badge, .btn-primary |
| 3 List screens | `ee15270` | Projects/Sessions full-bleed + divided rows |
| 4 IDE shell | `4cd7e6b` | topbar/panes/composer, amber handles |
| 5 Settings/mkt/login/shell | `8d2af6c` | full-bleed + Panel + square |
| 6 Polish | `22b28ef` | toast squared |

**Verification:** `tsc` clean · **54/54 tests** · `vite build` ok at every phase.
**WCAG AA (on `#080808`):** all tokens ≥ 4.5:1 — accent 9.33, success 11.49,
warning 12.0, info 7.88, untracked 7.36, danger 7.24, fg 16.05, fg-muted 5.96,
fg-subtle 6.27, button text (black on amber) 9.78. No failures.
**A11y:** all `animate-*` motion-reduce gated; testids/aria/roles/focus preserved;
`packages/ui` untouched throughout.
**Remaining:** visual screenshot diff vs comp (needs full dev stack) and optional
`/code-review` — not yet run.

## Sequencing notes
- Phases 1→2 are prerequisites for 3/4/5 (which are parallelizable across contexts).
- Each of 3, 4, 5 is independently shippable and testable.
- Keep PRs per-phase for reviewable diffs.
