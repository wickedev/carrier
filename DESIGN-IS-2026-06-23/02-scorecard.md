# Design Is — Scorecard (2026-06-23)

Each principle 0–3 against the Phase-2 anchors. Tie-breaker: when uncertain, score lower. Score the worst representative instance, not the mean.

1. **Good design is innovative — Score: 2/3**
   Evidence: 3-pane live-SSE agent IDE + inline HITL tool approvals + capability-consent install dialog (01: structural, copy). 
   Justification: refreshes existing IDE/agent patterns with a clear improvement (the honest consent flow + inline approvals), but the constituent parts are conventional shadcn — a refinement of the form, not a new one (not 3).

2. **Good design makes a product useful — Score: 2/3**
   Evidence: primary task (project→session→drive agent) is directly supported and 100% keyboard-reachable (01: accessibility), but the adjacent settings/config surface is ~50+ controls and carries dead/unreachable UI (01: structural — dead scope select, dead `projectName`).
   Justification: the primary task completes, but the adjacent configuration surface adds steps and ships unreachable controls (anchor 2, not 3).

3. **Good design is aesthetic — Score: 2/3**
   Evidence: disciplined ~4px spacing grid + tight 12/14/18 type scale + single hue-disciplined neutral+4-accent palette (01: visual), but orphan styles (`text-[11px]`, fractional one-offs), flat heading hierarchy, loose accent-shade usage, and divergent status components.
   Justification: a single system is clearly visible and largely obeyed, but the orphan styles + flat hierarchy are >2 minor inconsistencies that bar a clean 3 (anchor 2; "no orphan styles" required for 3).

4. **Good design makes a product understandable — Score: 1/3**
   Evidence: heavy jargon with no in-UI explanation — Promote, Steer/Queue, Seams, MCP, plan mode, effort "xhigh", git A/M/D/U badges with no legend (01: copy); the "Promote" label→behavior ambiguity (01: copy mismatch).
   Justification: primary actions are identifiable (not 0), but well more than 2–3 secondary controls are unclear with pervasive unexplained jargon (anchor 1). **Lowest principle — the leading fix.**

5. **Good design is unobtrusive — Score: 2/3**
   Evidence: monochrome primary + neutral palette let content be the figure (01: visual), but ~3 always-on TopBar pills + redundant on/off text labels + decorative divider add quiet chrome (01: structural, weight).
   Justification: chrome is visible but quiet; a few redundant affordances keep it from receding fully (anchor 2).

6. **Good design is honest — Score: 3/3**
   Evidence: zero inflations, zero dark patterns; consent dialog exemplary (`permissions.allow` off-by-default + warning, capabilities individually visible, "unchecked = denied" disclosure); two-step destructive confirms (01: copy & honesty).
   Justification: every claim, badge, and capability grant maps 1:1 to behavior; the single "Promote" label ambiguity is a clarity issue scored under #4 (not double-counted here), so honesty is exemplary (anchor 3).

7. **Good design is long-lasting — Score: 3/3**
   Evidence: monochrome neutral system, no trend gradients/skeuomorph/fad typography; would read as current in 3 years (01: visual).
   Justification: the restraint deliberately avoids fashionable markers — exactly the long-lasting anchor (3); no dated trend markers found.

8. **Good design is thorough down to the last detail — Score: 2/3**
   Evidence: empty/loading/error/disabled/focus all present via shared primitives, BUT **success state absent** across all mutations, focus rings missing on a class of controls, `prefers-reduced-motion` ignored, dark-mode FOUC, and no `aria-live` on the streaming output (01: visual, weight, accessibility).
   Justification: 5 of 6 states are present and considered; success is the one missing state (anchor 2), though the focus/motion/FOUC/live-region gaps make it a low 2.

9. **Good design is environmentally friendly — Score: 2/3**
   Evidence: 293 kB gzip (<500 kB) with motion gated to in-flight states, BUT a single un-split chunk (login pays full CodeMirror+IDE) and `prefers-reduced-motion` unrespected (01: weight).
   Justification: under the 500 kB transfer bar with gated motion (anchor 2), but no code-splitting + ignored reduced-motion bar the 3.

10. **Good design is as little design as possible — Score: 1/3**
    Evidence: 8 near-identical "section" blocks, 4× re-inlined delete buttons, ~6× redundant on/off labels, decorative divider, dead scope select + dead props + unused variant (01: structural).
    Justification: 3–5+ removable/duplicated elements and an unfactored repeated pattern across the densest surface (anchor 1).

---

## Total: 20 / 30

(2 + 2 + 2 + 1 + 2 + 3 + 3 + 2 + 2 + 1)

No principle scored 0. Lowest: #4 understandable (1) and #10 as-little-design (1).
