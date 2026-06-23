# Design Is — Verdict (2026-06-23)

## Verdict: REFINE (20/30)

The Carrier web UI has good, honest, durable bones — a coherent monochrome system, exemplary capability-consent honesty, and 100% keyboard-reachable flows — so it earns a focused refinement pass, not a restart (total 20 ≥ 20, no principle scored 0).

It is, candidly, a **low REFINE sitting right on the boundary**: the score is carried by honesty (#6=3) and durability (#7=3), while clarity (#4=1) and over-design/duplication (#10=1) are real weaknesses. The failure mode is *not* purpose failure — the IA and core task flows are sound — so the work is to sharpen what exists.

## Highest-leverage moves (each tied to a principle + evidence)

1. **#4 understandable (1) — Kill the jargon and the "Promote" ambiguity.** Disambiguate `Promote` so the outcome is stated *before* the click ("Open PR" vs "Merge to `main`"); add helper text to Steer/Queue, a tooltip for Plan mode, a legend for the A/M/D/U git badges, and expand "MCP". Evidence: `TopBar.tsx:130`, `session.tsx:96-115`, `Composer.tsx:57,70`, `FileTree.tsx:16-22`, `config-sections.tsx:372`.

2. **#3/#8 contrast — Introduce real design tokens and fix the WCAG AA failures.** `text-neutral-400` (~2.55:1) and `text-red-500` (~3.8:1) on light backgrounds fail AA for normal text, and `text-neutral-500` (the default body color) is borderline; promote secondary text to ≥neutral-500/600 and errors to red-600, encoded as tokens rather than inline utilities. Evidence: 01 visual/accessibility — `UsagePanel.tsx:35`, `primitives.tsx:53,96`, config-section error classes.

3. **#10 as little design (1) — De-duplicate and delete dead UI.** Extract the Card+form+list "section" into ONE component (8 near-identical copies), use the existing `DeleteButton`/`EnableToggle` everywhere (re-inlined 4×/6×), and remove the dead `InstallConsentDialog` scope-select, the `projectName` prop, the unused `destructive` variant, and the decorative "or" divider. Evidence: `config-sections.tsx:137,252,370`, `marketplace.tsx:438-451`, `login.tsx:126-130`.

4. **#8 thorough (2) — Close the last-detail gaps.** Add a success/confirmation state after mutations, app-level `focus-visible` rings on the toggle/delete/select controls, `aria-live="polite"`/`role="log"` on the streaming agent output, respect `prefers-reduced-motion`, and an inline head script to kill the dark-mode FOUC. Evidence: `settings.tsx:88`, `AgentPanel.tsx:43`, `index.html`.

5. **#9 environmentally friendly (2) — Code-split the IDE.** The login/list screens currently ship the full 937 kB (293 kB gzip) single chunk including CodeMirror + the IDE; lazy-load the session/IDE route so the entry screens pay only their own cost. Evidence: vite single-chunk build output; `routes/router.tsx` static imports.

## Explicitly NOT in scope (preserve — these scored well)
The information architecture and core task flow (project → session → drive agent → approve → promote), the honest capability-consent dialog (#6=3), the monochrome neutral visual language and 4px/14px systems (#7=3, #3 base), and keyboard reachability. Refine within these — do not restructure them.
