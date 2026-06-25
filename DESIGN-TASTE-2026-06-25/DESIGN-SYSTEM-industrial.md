# Carrier — Industrial / Terminal Design System

> Implementation spec for the approved full redesign. Archetype: **Tactical
> Telemetry (Dark)** from the `industrial-brutalist-ui` skill, adapted for a
> daily-use devtool. Reference comp: `design-mockups/industrial.html`.
> Stack: React + Tailwind v4, CSS-variable tokens.

## 0. Adaptation notes (skill → product UI)

The skill targets poster/landing brutalism. Three deliberate downshifts for an
IDE that engineers stare at all day:

1. **Accent is amber, not hazard red.** The skill's sole-accent red collides
   with Carrier's established `--danger` (red). Amber `#F59E0B` is the brand /
   primary action color (matches the approved comp).
2. **No CRT scanlines / halftone / global noise over working surfaces.** They
   wreck readability of the editor + agent stream and cost GPU. The grid-rule
   background appears only on list/landing views (Projects, Sessions), never
   behind the editor, diff, or stream.
3. **No viewport-bleeding clamp() numerals.** Macro-type is used for page
   titles only, at a controlled scale. Density is the identity, not spectacle.

Everything else from the skill holds: monospace dominance, 1px grid
compartmentalization, radius 0, uppercase micro-labels, high data density,
ASCII framing used sparingly.

## 1. Tokens

### 1.1 Type
- **Mono (default, everything):** `JetBrains Mono`. Self-host via `@font-face`
  + `font-display: swap` (no `<link>` in prod).
- **Display (page titles only):** `Space Grotesk` 700.
- Scale (fixed, no fluid clamp except page title):
  - `--text-3xs .625rem` / `--text-2xs .6875rem` (already defined) — micro labels
  - `text-xs .75rem` — metadata, table cells, status
  - `text-sm .875rem` — body / list titles
  - page title: `text-2xl` (1.5rem) display, others stay small
- **Casing:** UPPERCASE for all micro-labels, nav, column headers, status,
  section headers (`tracking-[0.15em]`). Sentence case for user content
  (session titles, agent messages, code).

### 1.2 Color (extends existing token layer)
Substrate = Tactical dark. Reuse `index.css` semantic tokens; add brand + chrome.

```css
:root, .dark {            /* industrial is dark-first; light mode optional later */
  --bg:        #080808;   /* deactivated CRT, not pure black */
  --panel:     #0e0e0e;
  --line:      #242424;   /* the 1px grid color */
  --fg:        #e6e6e6;   /* phosphor white */
  --fg-muted:  #8c8c8c;
  --fg-subtle: #5a5a5a;
  --accent:    #f59e0b;   /* amber — brand + primary action */
  --accent-fg: #000000;   /* text on amber fills */
}
```
Semantic state tokens **unchanged** and reserved for state only:
`--success` (green: added / live / pass), `--info` (blue: idle / running /
links), `--untracked` (violet: U / thinking), `--danger` (red: deleted /
destructive). `--warning` (amber) and `--accent` share the amber family on
purpose — both mean "attention"; differentiate by *application* (warning =
text/border, accent = solid fill).

### 1.3 Geometry & spacing
- **`border-radius: 0` everywhere.** Remove every `rounded-*`. (Override the
  shared `@carrier/ui` button radius at the app layer if the package can't be
  edited.)
- **Borders:** `1px solid var(--line)` for all compartment edges. Prefer the
  `display:grid; gap:1px; background:var(--line)` trick for razor dividers.
- **Spacing:** keep the 4px scale. Density target: list rows `py-3.5`, tight
  metadata clusters `gap-1`/`gap-2`.
- **Focus ring:** keep the `.focus-ring` utility but switch its color to
  `--accent` (amber) for the industrial look.

## 2. Components (rebuild map)

| Component | Industrial rule |
|---|---|
| **Button / primary** | amber fill, black text, radius 0, uppercase, no shadow. Hover: `brightness(1.1)`. |
| **Button / secondary** | transparent, `1px var(--line)`, uppercase, hover border→neutral-500. |
| **List row** (project/session) | full-width grid row, 1px bottom divider, leading index `01/02`, hover `bg-neutral-900`, trailing `→`. No cards. |
| **Column header** | `text-2xs` uppercase `tracking-[0.15em]` subtle, above `border-y` list. |
| **Status pill** | `text-xs` uppercase, glyph + label, color = semantic token (◌ IDLE = info, ● LIVE = success). No filled background. |
| **Badge (git A/M/D/U)** | bold single letter, semantic color, no fill. |
| **Tab toggle** (File/Diff, Queue/Steer) | square segmented, active = amber underline or amber fill. |
| **Panel / section** | bordered compartment with uppercase header strip; NOT a rounded shadowed card. |
| **Input / textarea** | transparent, 1px border, radius 0, focus border = amber. |
| **Breadcrumb** | uppercase mono, `/` subtle separators, current = amber or fg. |
| **Grid background** | `linear-gradient` 40px grid at `--line`, list/landing views only. |

ASCII framing (`[ … ]`, `▸`, `→`, `●/◌`) used as functional glyphs, sparingly —
not decoration on every element (avoid the eyebrow-spam tell).

## 3. Layout / IA

- **Kill the 750px centered column.** Go full-width with `max-w-6xl` content
  inside, anchored top-left, not floating mid-viewport.
- **Top bar:** `CARRIER` wordmark + org switcher + theme/user. 44px, 1px bottom.
- **List screens (Projects, Sessions):** header row (title + actions) over a
  bordered, divided list. Grid-rule background. Column headers for sessions.
- **IDE (session):** keep 3-pane `grid-cols-[240px_1fr_380px]`, separated by 1px
  rules. Each pane has an uppercase header strip. Default to the *populated*
  state; empty states are terse single lines, not large centered illustrations.

## 4. Motion (MOTION_INTENSITY 2)

Minimal and functional only. Allowed: `:hover`/`:active` transitions
(`brightness`, `bg`), the existing spinner (`motion-reduce` gated), a 1px
`animate-pulse` "running" dot. **Banned:** scroll hijacks, parallax, decorative
loops. Everything `> 3` honors `prefers-reduced-motion` (already wired).

## 5. Phased implementation (for make-plan / do)

1. **Tokens + base** — add `--bg/--panel/--line/--accent` to `index.css`; set
   global `border-radius:0`; recolor `.focus-ring` to amber; self-host fonts.
2. **Primitives** — rebuild `Button` wrapper, `Card`→`Panel`, `Badge`, `Toggle`,
   `Input`, status pills, `EmptyState`/`ErrorState` to the rules above.
3. **List screens** — `org.tsx` (Projects), `project.tsx` (Sessions): full-width
   + grid rule bg + divided rows + column headers.
4. **IDE shell** — `TopBar`, `IdeLayout`, `FileTree`, `EditorDiff`, `EventList`,
   `Composer`: 1px compartments, uppercase header strips, populated-first.
5. **Settings / marketplace / login / config-sections** — apply primitives.
6. **Pass** — `/code-review`, contrast audit (amber/semantic on `#080808`),
   keyboard + reduced-motion regression, screenshot diff vs comp.

Carries forward: the semantic color token layer, focus-ring utility, toast
hardening, Composer dedup already shipped on `design-taste-tokens`.
