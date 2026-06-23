# Design Is — /make-plan Handoff (2026-06-23)

Copy the fenced block below into a fresh session.

````
/make-plan Refine the Carrier web app UI based on a Dieter Rams audit (total 20/30).

Verdict (from the audit):
> The Carrier web UI has good, honest, durable bones — a coherent monochrome system, exemplary capability-consent honesty, and 100% keyboard-reachable flows — so it earns a focused refinement pass, not a restart (no principle scored 0). It is a low REFINE on the boundary: carried by honesty and durability, weak on clarity (#4=1) and over-design/duplication (#10=1). The IA and core flows are sound; sharpen what exists.

Keep (already strong, do NOT touch in this pass):
- #6 Honest (3) — the plugin install consent dialog: `permissions.allow` off-by-default + amber warning, capabilities individually visible/deselectable, "unchecked = denied at runtime" disclosure. Evidence: web/apps/web/src/routes/marketplace.tsx:404,417,435,521. Regression check: grep that `allowPermissions` state still defaults `useState(false)` and the submit still gates on `caps.permissionsAllow`.
- #7 Long-lasting (3) — the monochrome neutral visual language (primary = bg-neutral-900 / dark:bg-neutral-100), no trend gradients. Evidence: packages/ui/src/button.tsx:10. Regression check: no new hue families or gradient/skeuomorph styles introduced.
- Information architecture + core flow (project → session → drive agent → approve → promote) and 100% keyboard reachability (every action a real button/a/input/select). Regression check: no div/span onClick added; primary flow unchanged.

Fix in priority order:
1. #4 Understandable: kill jargon + the "Promote" ambiguity. State the outcome BEFORE the click — "Open PR" vs "Merge to `main`" (api.promote either opens a PR or merges directly today). Add helper text to the Steer/Queue delivery toggle, a tooltip to "Plan mode", a legend/tooltips for the A/M/D/U git badges, and expand "MCP servers" with a one-line subtitle. Evidence: web/apps/web/src/components/ide/TopBar.tsx:130, routes/session.tsx:96-115, components/ide/Composer.tsx:57,70, components/ide/FileTree.tsx:16-22, routes/config-sections.tsx:372.
2. #3/#8 Contrast + tokens: introduce a real design-token layer (CSS vars / Tailwind theme — there are currently NO tokens, all inline default utilities) and fix the WCAG AA failures: `text-neutral-400` (~2.55:1) and `text-red-500` (~3.8:1) on light backgrounds fail AA for normal text; default body `text-neutral-500` is borderline (~4.5:1). Promote secondary text to ≥neutral-500/600 and inline errors to red-600. Evidence: web/apps/web/src/components/ide/UsagePanel.tsx:35, components/primitives.tsx:53,96, routes/config-sections.tsx (create-error classes).
3. #10 As little design: extract the Card+add-form+list "section" into ONE shared component (8 near-identical copies across config-sections.tsx:137,252,370,468,570 + settings.tsx:91,349 + marketplace.tsx:565); use the existing DeleteButton/EnableToggle everywhere (re-inlined 4×/6×); delete the dead InstallConsentDialog scope-select (marketplace.tsx:438-451 — install is always org-scoped), the always-undefined `projectName` prop (session.tsx:133 → TopBar.tsx:88), the unused `destructive` Button variant (packages/ui/src/button.tsx:13), and the decorative "or" divider (login.tsx:126-130).
4. #8 Thorough: add a success/confirmation state after mutations (none today — silent reset), app-level focus-visible rings on the toggle/delete/`<select>` controls (currently UA-default only), `aria-live="polite"`/`role="log"` on the streaming agent output (components/ide/AgentPanel.tsx:43), respect `prefers-reduced-motion`, and an inline <head> theme script to remove the dark-mode FOUC (index.html only loads main.tsx).
5. #9 Environmentally friendly: code-split the IDE — login/list currently ship the full 937 kB raw / 293 kB gzip single chunk incl. CodeMirror; lazy-load the session/IDE route. Evidence: vite single-chunk build output; web/apps/web/src/routes/router.tsx (all static imports).

Out of scope for this refine pass: the information architecture, the core task flow, the consent-dialog honesty model, and the monochrome visual language. If any of these must change structurally, stop and re-audit — that would be a REDESIGN, not this refine.

Deliverables for the plan:
- Per-fix: target files, exact change, verification step (incl. a contrast check hitting WCAG AA and an axe/lighthouse a11y pass).
- Token/spec changes consolidated in one place (the new design-token layer).
- Regression checklist for every "Keep" item above.

Anti-patterns to guard against (REFINE):
- Adding new abstractions where a direct change suffices.
- Restyling the areas that already scored 3 (consent honesty, monochrome language).
- Scope creep into structural redesign (if structure must change, this is REDESIGN, not REFINE).
- Letting fixes mutate principles outside the priority list (e.g. a token refactor that breaks dark mode).
````
