# Carrier Web UI — Refine Plan (from Design-Is audit, 20/30 REFINE)

LLM-friendly, phase-by-phase. Each phase is self-contained (its own doc refs, copy-from anchors, verification, anti-pattern guards) and can run in a fresh chat context. Execute Phases 1→6 in order. Do NOT restructure the IA or core flows — this is a refine (see `03-verdict.md` "preserve" list).

Repo: `/Users/ryan/Workspace/carrier/web`. Verify after each phase with: `pnpm --filter @carrier/web typecheck && pnpm --filter @carrier/web test`. Final build/e2e in Phase 6.

---

## Phase 0 — Allowed APIs (read before any edit; do not invent beyond this)

Established by documentation discovery (Tailwind v4.3.1, React Router 7.1.1, source reads). Sources in brackets.

**Tailwind v4 design tokens** — current entry is `apps/web/src/index.css`:
```css
@import "tailwindcss";
@variant dark (&:where(.dark, .dark *));
```
[index.css:1-3]. Tailwind v4 emits default palette as CSS vars on `:root` (e.g. `--color-neutral-600`, `--color-red-600`) [tailwindcss@4.3.1 theme.css]. Theme-AWARE semantic tokens are made with runtime vars in `:root`/`.dark` + a `@theme inline { --color-x: var(--x) }` mapping (the `inline` keyword is required so the `.dark` override applies). New utilities `text-<name>` / `bg-<name>` / `border-<name>` come from `--color-<name>`.

**Motion** — Tailwind v4 has built-in `motion-reduce:` / `motion-safe:` variants. 13 `animate-spin` usages exist [primitives.tsx:8, TopBar.tsx, project.tsx, settings.tsx ×2, marketplace.tsx, config-sections.tsx ×6].

**Dark-mode FOUC** — no head script today; `index.html` only loads `main.tsx` [index.html:1-12]. Theme key/class are EXACT: localStorage `"carrier.theme"`, class `dark` on `<html>` [theme.ts:5,16; matchMedia fallback theme.ts:7-12].

**React Router v7.1.1 code-splitting** — `createBrowserRouter([...])` with static `element:` [router.tsx:28-53]. Supported lazy form: a route object's `lazy: () => import("./x").then(m => ({ Component: m.X }))`. Heavy route = the session/IDE route (`SessionPage`), because `EditorDiff` imports `@codemirror/*` [routes/session.tsx; EditorDiff.tsx:2-5]. Fallback: reuse the existing `Loading` primitive [primitives.tsx:50-59].

**WCAG-safe neutrals (AA 4.5 normal / 3.0 large)** — FAILING on light bg today: `text-neutral-400` (~2.8–3:1), `text-red-500` (~3.8–4.2:1); `text-neutral-500` is borderline (~4.5:1). PASS on light: `neutral-600`/`700`, `red-600`/`700`. Dark mode already passes for `neutral-400`/`red-400` on `neutral-950`.

**Anti-patterns (do NOT do):** invent a tailwind.config (this is v4, CSS-config); add a toast NPM dependency (build success-state from a small in-repo context — Phase 4); use `React.lazy` without a `<Suspense>` fallback; change route paths or the IA; restyle the consent dialog (`marketplace.tsx`) or the monochrome primary (`packages/ui/src/button.tsx:10`) — those scored 3 and are in the preserve list.

---

## Phase 1 — Design tokens + WCAG AA contrast (principles #3, #8)

**What to implement (copy the exact CSS below, then migrate usages):**

1. In `apps/web/src/index.css`, ADD a theme-aware token layer (the default palette vars already exist on `:root`):
```css
@import "tailwindcss";
@variant dark (&:where(.dark, .dark *));

:root {
  --fg:        var(--color-neutral-900);
  --fg-muted:  var(--color-neutral-600);  /* AA on white */
  --fg-subtle: var(--color-neutral-500);  /* AA-large; use for ≥14px secondary */
  --danger:    var(--color-red-600);      /* AA on white */
  color-scheme: light;
}
.dark {
  --fg:        var(--color-neutral-100);
  --fg-muted:  var(--color-neutral-400);  /* AA on neutral-950 */
  --fg-subtle: var(--color-neutral-500);
  --danger:    var(--color-red-400);
  color-scheme: dark;
}
@theme inline {
  --color-fg:        var(--fg);
  --color-fg-muted:  var(--fg-muted);
  --color-fg-subtle: var(--fg-subtle);
  --color-danger:    var(--danger);
}
/* keep the existing html,body,#root { height:100% } block */
```

2. Migrate the FAILING contrast usages to the tokens (these collapse `text-neutral-X dark:text-neutral-Y` pairs into ONE token, which also helps #10):
   - Replace **secondary/muted text** `text-neutral-400`/`text-neutral-500` (+ their `dark:` pair) with `text-fg-muted`. Anchors to fix: `components/ide/UsagePanel.tsx:35`, `components/ide/TopBar.tsx` (idle/terminated/`text-neutral-400`), `components/ide/Composer.tsx:44`, `components/ide/EventList.tsx` (`text-neutral-400`), `components/ide/FileTree.tsx` (icons/`loading…`), `components/primitives.tsx:53,75` (Loading/EmptyState body), `components/Shell.tsx`.
   - Replace **inline form/error text** `text-red-500` with `text-danger`: every `config-sections.tsx` create-error line, `components/primitives.tsx:96` (ErrorState), `components/ide/EventList.tsx`, `routes/login.tsx` error text.
   - Leave true-decorative icon colors and the green/amber status accents as-is (not body text).

**Doc references:** Phase 0 (Tailwind v4 `@theme inline`, theme.css palette vars, WCAG-safe neutrals). Token-aware pattern is the documented v4 mechanism for light/dark semantic colors.

**Verification checklist:**
- `pnpm --filter @carrier/web typecheck` clean.
- `grep -rn "text-neutral-400" apps/web/src` returns **zero** results for *text* (icon-only decorative use, if any remains, must be justified).
- Manually confirm (or compute) AA: `--fg-muted` = neutral-600 on white ≈ 6:1 (PASS), neutral-400 on neutral-950 ≈ 7.8:1 (PASS); `--danger` = red-600 on white ≈ 5.2:1 (PASS).
- Build still themes correctly in both light and dark (spot-check via `make dev`).

**Anti-pattern guards:** do not introduce new hue families; do not hardcode hex (use the palette vars); do not drop the `inline` keyword (the dark override silently breaks without it); do not touch the monochrome primary button.

---

## Phase 2 — De-duplicate + delete dead UI (principle #10)

**What to implement (extract one component, then replace copies; delete dead code):**

1. **Promote `DeleteButton` and `EnableToggle` to a shared module.** They are defined in `routes/config-sections.tsx:63-83` (DeleteButton) and `:37-60` (EnableToggle). Move both into `apps/web/src/components/primitives.tsx` (or a new `components/config/controls.tsx`) and export them. Then COPY their usage everywhere they're currently RE-INLINED:
   - `routes/settings.tsx:133-141` (member remove) → `<DeleteButton>`.
   - `routes/settings.tsx:414-422` (permission delete) → `<DeleteButton>`.
   - `routes/marketplace.tsx:597-605` (uninstall) → `<DeleteButton>`; `:587-595` (plain checkbox) → `<EnableToggle>`.

2. **Extract the repeated "Card + add-form + list" section shell.** The pattern repeats 8× [config-sections.tsx AgentsSection 103-210, SkillsSection 214-331, McpServersSection 335-440, ContextSection 444-523, HooksSection 536-645, EnvVarsSection 649-740; settings.tsx MembersSection 75-151; marketplace.tsx InstalledPluginsSection 552-615]. Create a `<ConfigSection>` shell component that owns: the `Card` + `<h2>` title + the loading/error/empty branches + the `<ul divide-y>` list wrapper, taking `title`, `manage`, `query` (the useQuery result), `renderItem`, and a `form` slot. Refactor the per-section components to render their FORM + `renderItem` through the shell. (Copy the loading/error/empty branch verbatim from AgentsSection 174-207 as the canonical body.) This is the load-bearing dedup — do it carefully, one section at a time, keeping tests green.

3. **Delete dead code:**
   - `routes/marketplace.tsx:438-451` — remove the `InstallConsentDialog` scope-`<select>` and the `scope === "project"` branch; install is always org-scoped (`projectScope` is never passed). Drop the `projectScope` prop.
   - `routes/session.tsx:133` — remove `projectName={undefined}`; remove the `projectName` prop from `TopBar` (`TopBar.tsx:54,88`), collapse the breadcrumb to `projectId`.
   - `packages/ui/src/button.tsx:13` — remove the unused `destructive` variant.
   - `routes/login.tsx:126-130` — remove the decorative "or" divider (keep the GitHub button directly under the form, or a single hairline if a separator is wanted).

**Doc references:** anchors above (all file:line confirmed in discovery). Reuse existing `Card`/`EmptyState`/`Loading`/`ErrorState` from `primitives.tsx:11-108`.

**Verification checklist:**
- `pnpm --filter @carrier/web typecheck && pnpm --filter @carrier/web test` green (the config-sections + settings + marketplace tests still pass — adjust selectors only if markup ids/test-ids changed; keep `data-testid`s).
- `grep -rn "GitPullRequest\|projectName" apps/web/src` shows no `projectName` prop left; `grep -rn "destructive" packages/ui apps/web/src` shows zero.
- Each refactored section renders identically (visual spot-check via `make dev`).

**Anti-pattern guards:** do not over-abstract (the shell takes slots, not a config-driven mega-form); keep every existing `data-testid`; do not merge the consent dialog logic away — only delete the proven-dead scope select.

---

## Phase 3 — Clarity / kill jargon + "Promote" ambiguity (principle #4 — the lowest score)

**What to implement (relabel + add in-UI explanation; copy nothing new structurally):**

1. **"Promote" → outcome-explicit.** Handler `routes/session.tsx:96-115` calls `api.promote()` which EITHER opens a PR OR merges directly to base. Make the outcome knowable before the click:
   - If the project is repo-bound (a PR will be opened), label the button **"Open PR"** with the `GitPullRequest` icon.
   - If unbound (a direct merge to base), label it **"Merge to base"** (or `Merge to {branch}`) with a `GitMerge` icon, and gate it behind the existing confirm pattern (copy the two-step confirm from `settings.tsx:491-505` DangerZone).
   - Source the bound/unbound state from the session/project data already in `session.tsx`. Button at `components/ide/TopBar.tsx:128-131`.
2. **Steer/Queue** [`components/ide/Composer.tsx:57,70`] — add a one-line helper under the toggle: "Queue = send after the current step · Steer = interrupt and redirect now" (the explanation currently lives only in a code comment, Composer.tsx:8-9).
3. **Plan mode** [`routes/project.tsx:83`, `config-sections.tsx:837`] — add a `title=`/tooltip: "Agent drafts a plan before editing code."
4. **Git status badges A/M/D/U** [`components/ide/FileTree.tsx:16-22`] — add per-badge `title` tooltips (Added/Modified/Deleted/Untracked); optionally a one-line legend at the tree footer.
5. **"MCP servers"** [`config-sections.tsx:372`] — add a subtitle: "Model Context Protocol — external tool servers."
6. **Working-copy dirty dot** [`components/ide/TopBar.tsx:100`] — add `title="Uncommitted changes"`.

**Doc references:** anchors above; reuse the existing confirm pattern at `settings.tsx:491-505`; reuse `Badge`/tooltip-by-`title` (no tooltip library — native `title` is the project norm).

**Verification checklist:**
- `pnpm --filter @carrier/web typecheck && test` green (update the e2e/unit copy assertions that referenced "Promote" if any).
- Manual: on a repo-bound vs unbound session, the action label correctly reads "Open PR" vs "Merge to base"; a direct merge requires confirm.
- `grep -rn "Promote" apps/web/src` only remains where intentionally kept.

**Anti-pattern guards:** do not add a tooltip dependency (use native `title`); do not change `api.promote`'s behavior (BFF/runtime is out of scope) — only make the UI honest about which branch it takes; do not rename the underlying `promote` API.

---

## Phase 4 — Thoroughness: success state, focus, live region, motion, FOUC (principle #8)

**What to implement:**

1. **Success feedback (no NPM dep).** Add a tiny in-repo toast: a `ToastProvider` context + `useToast()` in `apps/web/src/components/toast.tsx` (~40 lines: a context holding `{id,message}[]`, a portal `<div aria-live="polite" role="status">` bottom-right, auto-dismiss via `setTimeout`). Mount `<ToastProvider>` in `App.tsx` around the router. Then call `toast("Saved")` (or "Removed"/"Installed") in the mutation `onSuccess` callbacks at: `config-sections.tsx:127,241,360,460,561,665` (and the model-params save), `settings.tsx:88,346`, the repo bind/unbind, and marketplace install/uninstall. (If Phase 2 created `<ConfigSection>`, wire the success toast once in the shared add-handler path.)
2. **Focus-visible rings** on the controls that only get the UA default — add `focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:outline-none` (copy the exact ring from `packages/ui/src/button.tsx:6`) to: the moved `DeleteButton`/`EnableToggle` (Phase 2), `Composer.tsx:46,59` (Queue/Steer), `FileTree.tsx:122,143` (dir/file buttons), the `SELECT_CLASS` at `config-sections.tsx:31` and the install-scope-select-removal leftover selects, and `Shell.tsx:57` (OrgSwitcher options).
3. **Live region** for streaming output — add `aria-live="polite"` `aria-atomic="false"` `role="log"` to the agent output list. Prefer the `EventList` root `components/ide/EventList.tsx:115-124` (announces incremental events) over the scroll container `AgentPanel.tsx:43`.
4. **Reduced motion** — guard every `animate-spin` with `motion-reduce:animate-none` (or define a `Spinner` variant once in `primitives.tsx:7-9` and reuse). 13 sites (Phase 0 list). Fixing the `Spinner` primitive covers most; inline `<Loader2 animate-spin>` sites get `motion-reduce:animate-none`.
5. **Dark-mode FOUC** — add the blocking IIFE to `apps/web/index.html` `<head>` BEFORE the module script (exact script, keys match `theme.ts`):
```html
<script>
  (function () {
    var s = localStorage.getItem("carrier.theme");
    var dark = s === "dark" ? true : s === "light" ? false
      : matchMedia("(prefers-color-scheme: dark)").matches;
    if (dark) document.documentElement.classList.add("dark");
  })();
</script>
```

**Doc references:** Phase 0 (motion-reduce, FOUC script + exact key/class, focus ring source button.tsx:6); aria-live anchors AgentPanel.tsx:43 / EventList.tsx:115.

**Verification checklist:**
- `pnpm --filter @carrier/web typecheck && test` green.
- `grep -rn "animate-spin" apps/web/src | grep -v "motion-reduce"` returns zero (every spinner guarded).
- Manual: a successful add/delete shows a toast; tabbing reaches every delete/toggle/select with a visible ring; toggling `prefers-reduced-motion` stops spinners; hard-refresh in dark mode shows no light flash.
- Screen-reader spot check (VoiceOver): streaming agent text is announced.

**Anti-pattern guards:** no toast library; do not put `aria-live` on a container that re-renders wholesale (use the event list so only new nodes announce); the FOUC script must be inline + synchronous in `<head>` (not a module).

---

## Phase 5 — Code-split the IDE route (principle #9)

**What to implement:**

1. In `apps/web/src/routes/router.tsx:28-53`, convert the session route from a static `element:` to lazy:
```ts
{
  path: ":org/:project/s/:session",
  lazy: () => import("./session").then((m) => ({ Component: m.SessionPage })),
},
```
   Remove the static `import { SessionPage } from "./session"` at the top. If `SessionPage` needs the loader/params, it already reads them via hooks — no loader change.
2. Ensure a Suspense fallback exists. React Router renders the route's `Component`; wrap the app's `<RouterProvider>` (App.tsx:13-30) or the route element tree so a pending lazy chunk shows the existing `Loading` primitive. If using `lazy`, RR handles the pending state via the route — verify a fallback renders (add a `HydrateFallback`/`<Suspense fallback={<Loading/>}>` at the root if needed).
3. (Optional, same phase) lazy-split `marketplace` and `settings` routes the same way if the chunk is still large.

**Doc references:** Phase 0 (RR 7.1.1 `lazy` route property; heavy chunk = session→EditorDiff→@codemirror). 

**Verification checklist:**
- `pnpm --filter @carrier/web build` — the build now emits **multiple chunks**; the CodeMirror/session code is in a SEPARATE chunk, and the initial/entry chunk is meaningfully smaller than the current 936 kB raw / 293 kB gzip single chunk. Cite the new chunk sizes.
- Navigating to a session still works (the chunk loads on demand, fallback shows briefly); login/list no longer download CodeMirror.
- `pnpm --filter @carrier/web test` green; `pnpm --filter @carrier/e2e e2e` green (the IDE e2e still navigates correctly).

**Anti-pattern guards:** do not lazy-split the login/root shell (entry path must stay fast); ensure the lazy import path is correct (`./session` exports `SessionPage`); keep the `*` redirect route.

---

## Phase 6 — Verification (final)

1. **Contrast/a11y:** confirm no `text-neutral-400`/`text-red-500` on text remains (`grep`), and the new tokens pass AA in both themes. (Optional, no new dep required: a manual contrast pass on the 5 audited screens; if the team wants automation, add `@axe-core/playwright` to the e2e suite as a follow-up, not in this plan.)
2. **Anti-pattern grep guards (all must be empty/expected):**
   - `grep -rn "text-neutral-400" apps/web/src` → none for text.
   - `grep -rn "animate-spin" apps/web/src | grep -v motion-reduce` → none.
   - `grep -rn "destructive\|projectName" packages/ui apps/web/src` → none.
   - `grep -rn "React.lazy\|lazy:" apps/web/src/routes/router.tsx` → session route present.
3. **Full suite:** `pnpm -r typecheck && pnpm -r test && pnpm --filter @carrier/web build && pnpm --filter @carrier/e2e e2e` — all green; report the new bundle chunk sizes vs the 936 kB baseline.
4. **Regression check (preserve list from 03-verdict.md):** the consent dialog still defaults `permissions.allow` OFF and gates on `caps.permissionsAllow` (`marketplace.tsx`); the monochrome primary button is unchanged (`button.tsx:10`); core flow project→session→drive→approve→promote unchanged; zero `div/span onClick` introduced.

**Definition of done:** typecheck/test/e2e green; bundle code-split; AA contrast in both themes; success/focus/live-region/reduced-motion/FOUC all present; jargon clarified; duplicated/dead UI removed. Re-run `design-is` to confirm the lowest principles (#4, #10) moved up.
