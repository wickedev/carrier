# Plugin Marketplace — Tasks

Incremental, test-driven. Phases A–B are pure runtime (Go); C–E add the
marketplace and web surface. Each task references requirement IDs. Phase A is the
load-bearing prerequisite (it finally wires the existing `internal/hook` chain into
the Flight loop), so it ships value even before any marketplace exists.

## Phase A — Seam host & Flight wiring (runtime)

- [x] 1. Seam contract types + Chain
  - Define `internal/plugin`: `SeamKind`, the input/patch/decision Go types
    mirroring `carrier.plugin/v1`, the `Seam` interface, and `Chain` with the
    folding + fail-closed rules. Unit-test folding (deny short-circuit, system
    append concat, effort/model clamp, permission opt-in downgrade). _Req 2, 7.2_

- [x] 2. Wire Chain into the Flight loop
  - `flight.Config.Plugins *plugin.Chain`; call `BeforeStep` in `runTurn` before
    `RunStep`; wrap tool dispatch with `ToolBefore`/`ToolAfter`; consult
    `PermissionAsk` in permission evaluation; fire `SessionStart/End`. Reuse/replace
    the dormant `internal/hook` PreToolUse/PostToolUse path. Tests with a fake
    in-process `Seam` (deny a tool, rewrite input, append system, override result).
    _Req 6.3, 6.4_

- [x] 3. Native-Go seam adapter
  - A trivial first-party `Seam` built from Go funcs, proving the loop is backend-
    agnostic and giving first-party extensions a zero-sandbox path. _Req 2_

## Phase B — WASM sandbox (wazero)

- [x] 4. wazero Host: compile + instantiate + invoke
  - `internal/plugin/wasm`: shared runtime + compilation cache; the guest ABI
    (`alloc`/`dealloc` + per-seam entry points); `Module`/`Instance`; JSON
    marshal/unmarshal around `Invoke`. `wasmSeam` adapter implements `Seam`.
    _Req 3.1_

- [x] 5. Capability broker (host functions)
  - `log`, `http_fetch` (host allowlist + size/rate caps), `kv_get/set`
    (namespaced), `secret_get` (declared keys only). Each enforces the instance's
    `CapabilityGrant`. Tests: ungranted cap → error; out-of-allowlist host blocked;
    secret not in manifest blocked. _Req 3.2, 3.5_

- [x] 6. Resource limits & fail-closed
  - Per-call deadline (epoch interruption), per-instance memory cap, trap
    containment. Tests: an infinite-loop guest is interrupted at the deadline; a
    trapping guest disables the plugin but the session continues; permission-seam
    failure falls through to `perm.Policy` (never auto-allow). _Req 3.3, 3.4, 7_

- [x] 7. Reference guest SDK + sample plugin
  - A TinyGo (and Rust) guest SDK wrapping the ABI; a sample plugin implementing
    every seam, used as the host-test fixture and the author example. _Req 8_

## Phase C — Registry, signing & verification

- [x] 8. Bundle format + manifest schema + detached signing
  - Bundle tar layout; published JSON Schema for `carrier-plugin.json` (manifest
    records each artifact's `digest`, no self-hash/signature inside it). Define
    `manifest_digest = sha256(canonical(manifest))` as the version identity and a
    **detached** `carrier-plugin.sig` signing the manifest digest. A
    `carrier plugin pack/verify` CLI path. Tests: a tampered WASM (digest mismatch)
    fails; a tampered manifest (digest/signature mismatch) fails; a bad signature is
    rejected; the manifest contains no self-referential hash/signature field.
    _Req 1, 4.1, 4.3_

- [x] 9. Registry storage + publisher model (BFF)
  - `publisher` (key, verified), `plugin`, `plugin_version` tables + DDL; publish
    accepts only verified publishers and verifies the signature; search /
    list-versions / get-manifest endpoints (BFF-brokered). _Req 4.1, 4.2, 4.4_

## Phase D — Install, scope & assembly integration

- [x] 10. Install records + capability consent + lockfile (BFF)
  - `plugin_install` table; `POST/DELETE /orgs|projects/:id/plugins` (manager-gated);
    persist granted capabilities + `permissions.allow` opt-in + pinned
    version/manifest_digest; org allowlist enforcement; explicit upgrade with
    re-consent. Tests: non-manager 403; ungranted cap persisted as denied; allowlist
    blocks a disallowed plugin; install of an unverified/digest-mismatched bundle
    rejected.
    _Req 5_

- [x] 11. Assembly + SessionConfig wiring
  - `config-assembly` merges installed plugins' declarative layers (org then
    project, explicit config still wins); add `plugins[]` (name/version/
    manifest_digest/wasm_digest/granted_caps) to `SessionConfig` +
    `carrier-client.createSession` + Carrier
    `SessionOptions`. Tests: a declarative plugin's skills/agents appear in the
    assembled config; an active plugin's ref is forwarded. _Req 6.1_

- [x] 12. Runtime resolution + content-addressed cache
  - Carrier resolves active plugins' WASM by `wasm_digest` from a local CAS; cache
    miss fetches the manifest + detached signature + WASM (via BFF/artifact store)
    and runs full verification (recompute manifest digest → verify detached signature
    → verify WASM bytes against the manifest's recorded digest) before instantiating;
    per-session instances registered into the `Chain`. Tests: digest mismatch refuses
    load; tampered detached signature refuses load; cached artifact reused.
    _Req 4.3, 6.2, 7_

## Phase E — Web marketplace UI

- [x] 13. Browse & plugin detail
  - Marketplace list/search + a plugin detail page (versions, publisher verified
    badge, requested capabilities, seams). _Req 4_

- [x] 14. Install flow with capability consent
  - Scope selector (org/project), a capability-consent screen surfacing every
    requested capability + the `permissions.allow` opt-in, and the pinned-version
    lockfile view. Manager-gated. _Req 5.2_

- [x] 15. Installed-plugins management
  - Per-scope list of installed plugins with enable/disable, upgrade (re-consent),
    and uninstall; surfaced alongside the existing Configuration sections. _Req 5_

- [x] 16. Observability surface
  - Show plugin influence in the session trace (which plugin denied a tool / changed
    a permission / appended context), backed by the audit events from Req 7.4. _Req 7.4_

## Cross-cutting

- Security review gate: every install/load path verifies signature + integrity;
  no ambient authority; fail-closed defaults asserted by tests.
- Reuse, don't reinvent: config scope + assembly, MCP transport patterns, `bay`
  sandbox seam, `hook` middleware, `perm` policy, the secret store.
- Verified-only at launch; design keeps an open/community tier as a later flag.

## Suggested build order
A (1→2→3) establishes the seam + loop wiring (ships value alone) → B (4→5→6→7)
adds the sandbox → C (8→9) the registry → D (10→11→12) install + runtime resolution
→ E (13→16) the UI. A and the declarative half of D give a usable marketplace even
before the full WASM path lands.

## Implementation status (all 16 tasks)

Built and tested. Go: full `go test -race ./...` green incl. `internal/plugin`
(seam Chain folds), `internal/plugin/wasm` (sandbox: seam dispatch, capability
gating, deadline interrupt, trap containment, CAS digest verify, end-to-end Chain).
Web: 137 tests (contract 5, carrier-client 4, web 48, bff 80) + 6 Playwright E2E,
`@carrier/web` builds.

Honest deviations / follow-ups (interface real, depth bounded):
- **Task 7**: the reference guest is Go→wasip1 (c-shared), not TinyGo/Rust — same
  ABI. It implements a representative seam subset (before_step, tool_before with a
  gated secret read, permission_ask); a published TinyGo/Rust author SDK + a guest
  exercising every seam is a follow-up.
- **Task 5**: `log`, `secret_get` (declared keys only), `kv_get/kv_set` (namespaced)
  are implemented and grant-gated with tests; `http_fetch` is modeled (Network grant
  + manifest `network` capability + consent) but the host function (allowlisted
  egress) is not yet implemented — network-using plugins are a follow-up.
- **Task 12**: install-time verification (recompute manifest digest → verify detached
  ed25519 signature → verify WASM bytes) is done BFF-side; the Carrier runtime
  resolves from a content-addressed cache populated by the trusted BFF and
  re-verifies the **wasm bytes against the wasm digest** on load. A runtime that
  fetches manifest+signature directly and re-checks the full chain is a follow-up.
- **Task 16**: plugin influence is observable via the denied-tool reason carried in
  the tool result (surfaced in the session trace) + a `Chain.OnError` audit sink
  (stderr); a dedicated per-decision attribution widget in the IDE trace is a
  follow-up.
