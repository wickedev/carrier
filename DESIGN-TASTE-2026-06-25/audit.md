# Carrier Web — Taste Design Audit

> Authored through the **design-taste-frontend** (anti-slop) skill lens.
> Date: 2026-06-25 · Scope: `web/apps/web` (React + Tailwind v4 + CSS-variable tokens)
> Independent of the `DESIGN-IS-*` (Dieter Rams) audits — this is a taste / design-system pass.

---

## 0. Design Read

> **Reading this as:** an agent-supervision IDE / devtool for engineers, with a
> restrained monochrome system language, leaning toward Tailwind v4 +
> CSS-variable tokens + lucide icons.

**Inferred dials (existing product, not a baseline):**

| Dial | Value | Why |
|---|---|---|
| `DESIGN_VARIANCE` | 3 | Symmetric panels, predictable rhythm — correct for a tool. |
| `MOTION_INTENSITY` | 2 | Spinners + `motion-reduce` gating only; no decorative motion. Correct. |
| `VISUAL_DENSITY` | 6 | Daily-app density, tight IDE chrome. Correct. |

These are the *right* dials for the product. No dial change is recommended.

### Scope guard (important)

The skill explicitly excludes **code editors / dense product UI / dashboards**
(§13). Landing-page rules therefore **do not apply** and were not scored: hero
viewport fit, marquee limits, bento rhythm, eyebrow counts, CTA wrap, logo
walls. Only the transferable axes were audited:

1. **Design tokens** — consistency, coverage, adoption.
2. **UI/UX** — interaction clarity, accessibility of patterns.
3. **Visual language** — AI Tells, radius/shadow/icon discipline.

---

## 1. Verdict: **REFINE — good bones**

Against the anti-slop checklist this UI passes nearly everything. It is an
honest, durable devtool aesthetic. The only *structural* gap is an unfinished
semantic-color token layer; everything else is finishing work.

**What is already clean (preserve):**

- No AI Tells: no purple/neon glow, no oversaturated accents, no gradient text,
  no `<div>` fake screenshots, no em-dashes in UI copy, no decorative status-dot
  spam (the TopBar dirty `•` carries real state → allowed).
- Full dark mode, designed in both modes, FOUC killed by an inline head script
  (`index.html:7-14`).
- Consistent radius scale: `rounded` (badges) / `rounded-md` (inputs, buttons) /
  `rounded-lg` (cards). No broken mixing.
- Single icon family (lucide). The skill discourages lucide as a *default* but
  permits it when the project already depends on it — fine here.
- One accent-neutral system, system font, no fad typography → long-lasting.

---

## 2. Findings

### ① Design tokens — the one structural gap

The token system stops at neutrals + `--danger`. `index.css` defines only
`--fg / --fg-muted / --fg-subtle / --danger`. In practice, **~100 inline
semantic-color utilities** are scattered across **14 files**:

| Meaning | Current (inline, light/dark pairs) | Used in | Token? |
|---|---|---|---|
| success / running | `text-green-600 dark:text-green-400` ×10 | TopBar `StatusDot`, FileTree (A) | ❌ none |
| warning / dirty | `text-amber-*` ×18, `bg-amber-*` ×10 | TopBar, ApprovalCard, FileTree (M) | ❌ none |
| link / selection / info | `text-blue-*` ×17, `bg-blue-*` ×8 | TopBar PR, `ErrorState` Retry, FileTree selected | ❌ none |
| untracked | `text-violet-*` ×3 | FileTree (U) | ❌ none |
| danger | `text-red-*` ×27 | everywhere | ⚠️ **token exists, bypassed** |

Two concrete problems:

1. **`--danger` exists but is bypassed 27×** by inline `text-red-*`
   (e.g. `ApprovalCard.tsx:98`, `config-controls.tsx:55`, `primitives.tsx`
   `ErrorState`). The token was created but never adopted.
2. **No token for success / warning / info / untracked**, so the same meaning
   drifts: `ConnectionPill` uses `text-amber-500`, FileTree uses
   `text-amber-600`; greens split `600`/`400` ad hoc.

**Secondary token issues:**

- **Focus ring is a de-facto token, uncodified.**
  `focus-visible:ring-2 focus-visible:ring-neutral-400` is inlined 10+ times.
- **FileTree indentation sits off the spacing scale.**
  `FileTree.tsx:8-11` (`INDENT_STEP=12, ROW_PAD=4, TEXT_PAD=8, ICON_GUTTER=18`)
  computed inline via `style={{ paddingLeft }}`; `18` is off the 4px scale.
- **`--fg-subtle` is now OK.** Dark `#909090` = 6.2:1 (the earlier 4.18:1 flag is
  resolved); light `neutral-500` ≈ 4.6:1, passes AA-normal but tight.

### ② UI/UX — finishing work

- **Composer double-explains the delivery modes.** Both the segmented toggle
  `title` tooltips (`Composer.tsx:50-52`) **and** a persistent helper `<p>`
  (`Composer.tsx:66-68`) say the same thing. Permanent text noise on a
  high-frequency control. Keep one (recommend: tooltips + first-use/focus helper,
  not a permanent paragraph).
- **Toast has no manual dismiss / pause.** `toast.tsx:22` fixed 2500ms, no close
  button, no pause-on-hover. WCAG 2.2.1 (Timing Adjustable) risk for long
  messages / slow readers / SR users. `aria-live="polite"` is correct (good).

**Already resolved well (preserve):**

- Promote disambiguation — `Open PR` vs `Merge to base` with a two-step confirm
  for the destructive merge (`TopBar.tsx:138-190`). Exemplary.
- Git badges carry a `title` tooltip **and** a letter (A/M/D/U) alongside color →
  colorblind-safe (`FileTree.tsx:171-178`).
- ApprovalCard moves focus to the container (not the Approve button, to avoid
  accidental Enter-approve) (`ApprovalCard.tsx:54-60`).

### ③ Visual language — near clean

- No AI Tells (see §1).
- Radius scale consistent.
- **Card shadow** uses default Tailwind `shadow-sm` (cool blue-gray); the skill
  prefers shadows tinted to the background hue. On neutral surfaces it is nearly
  invisible — lowest priority.

---

## 3. Pre-Flight (transferable boxes only)

| Check | Result |
|---|---|
| Zero em-dashes in UI copy | ✅ |
| Page theme lock (one theme, no mid-page invert) | ✅ |
| Color consistency (one system) | ⚠️ system is consistent, but **untokenized** |
| Shape consistency (one radius scale) | ✅ |
| Button / form contrast WCAG AA | ✅ (`--fg-subtle` tight but passing) |
| Dark mode defined + tested both modes | ✅ |
| Empty / loading / error states present | ✅ (`primitives.tsx`) |
| Icons from one family, no hand-rolled SVG | ✅ (lucide) |
| Reduced motion honored | ✅ (`motion-reduce:animate-none`) |
| Timing adjustable (toast) | ❌ no dismiss/pause |
| Semantic tokens cover all stateful colors | ❌ success/warning/info/untracked missing; danger bypassed |

---

## 4. Recommended moves (priority order)

1. **[P1 · structural] Complete the semantic-color token layer.**
   Add `--success / --warning / --info / --untracked` in the same light/dark
   pattern as `--danger`, expose via `@theme inline`, then replace the ~100
   inline `text-green-*/amber-*/blue-*/violet-*/red-*` utilities with
   `text-success / text-warning / text-info / text-untracked / text-danger`.

2. **[P2 · finishing]**
   - Codify the focus ring (one utility/token for
     `ring-2 ring-neutral-400`).
   - Remove the Composer duplicate delivery explanation.
   - Add toast manual-dismiss + pause-on-hover/focus.

3. **[P3 · polish]**
   - Move FileTree indentation onto the spacing scale.
   - (Optional) tint the Card shadow to the surface hue.

All within **REFINE** scope. No redesign warranted.

---

## 5. Implementation log (applied 2026-06-25)

Branch: `design-taste-tokens`. Verified: `tsc --noEmit` clean · 54/54 tests pass ·
`vite build` ok · all new utilities present in the CSS bundle.

### P1 — semantic-color token layer ✅

- Added `--success / --warning / --info / --untracked` to `index.css`
  (light `-600`, dark `-400`, mirroring `--danger`); exposed via `@theme inline`
  as `--color-*` so Tailwind emits `text-* / bg-* / border-*` utilities.
- Replaced **all foreground semantic-color inline utilities** across 14 files
  with `text-success / text-warning / text-info / text-untracked / text-danger`
  (the previously-bypassed `--danger` is now adopted). Non-adjacent link cases
  (`text-blue-600 … hover:underline … dark:text-blue-400`) were hand-edited to
  `text-info`.
- **Left intentionally** (separate "surface tint" token family, not drift):
  subtle backgrounds/badges (`bg-*-50/100`, `border-*-200/300`, on-surface
  `text-*-700/300`, `*-950/900`) and the two-state resize-handle hover/drag
  background. Documented as out of P1 scope.

### P2 — finishing ✅

- **Focus ring codified.** Added `.focus-ring:focus-visible { @apply outline-none
  ring-2 ring-neutral-400 }` and replaced the 16 inline canonical strings + the
  3 input/textarea variants. (`packages/ui/button.tsx` keeps its own inline ring
  — that package is off-limits for edits.)
- **Composer de-duplicated.** Removed the always-on helper paragraph; the
  segmented toggle's `title` tooltips remain the single source of the
  Queue/Steer explanation.
- **Toast hardened (WCAG 2.2.1).** Added a per-toast dismiss button and
  pause-on-hover/focus (timer cleared on enter/focus, rescheduled on
  leave/blur); bumped auto-dismiss 2.5s → 5s.

### P3 — polish (partial)

- **FileTree indentation** kept as inline px (depth is dynamic, no static class
  can express it) but the magic numbers are now derived from a `UNIT = 4` base +
  the `ICON = 14` chevron, so they are explicitly on-scale. On inspection the
  `18px` gutter was *not* arbitrary: it equals chevron (14) + gap (4).
- **Card shadow tint** — left as default `shadow-sm` (marginal; deferred).
