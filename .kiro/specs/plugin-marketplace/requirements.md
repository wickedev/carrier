# Plugin Marketplace — Requirements

## Introduction

Carrier needs a first-class extension system: third-party, marketplace-distributed
**plugins** that extend a session's behaviour. Unlike a local single-user tool
(e.g. opencode, which runs plugins in-process with ambient authority), Carrier is
a **server-side, multi-tenant runtime** — a plugin is untrusted code running
alongside many tenants' sessions in the same fleet. The system therefore adopts
opencode's rich *interception surface* (transform the model request, rewrite tool
calls, weigh in on permission) but inverts its trust model: **out-of-process,
capability-based, zero ambient authority, resource-bounded**.

A plugin is a signed bundle with two optional layers:

- a **declarative layer** — skills, named sub-agents, MCP servers, context docs,
  command hooks, permission rules, model defaults (no code execution); reuses the
  existing per-session config assembly.
- an **active layer** — a WebAssembly module implementing one or more typed
  **seams** (`before_step`, `tool_before`, `tool_after`, `permission_ask`,
  `session_start`, `session_end`), run sandboxed in a wazero host.

Scope decisions (confirmed):
- v1 includes the **active (WASM) layer**, not declarative-only.
- Code sandbox is **WebAssembly via wazero** (pure-Go, no cgo).
- Launch curation is **verified publishers only**; an org may further restrict.

The terminology follows the fleet metaphor where natural; the plugin host is a new
`internal/plugin` package, the registry/marketplace is brokered by the BFF.

---

## Requirements

### Requirement 1 — Plugin manifest & bundle format
**User story:** As a plugin author, I want a declarative manifest describing what
my plugin contributes and needs, so the host and installer can reason about it
without executing it.

#### Acceptance Criteria
1. WHEN a plugin bundle is read THEN the system SHALL parse a `carrier-plugin.json`
   manifest declaring: `name`, `version` (semver), `publisher`, `api`
   (e.g. `carrier.plugin/v1`), the `seams` it implements, the `capabilities` it
   requests, an optional `declarative` config layer, and an `artifacts` map listing
   each referenced file (e.g. the WASM) with its content `digest`.
2. Integrity and signature SHALL be kept OUTSIDE the manifest to avoid a
   self-referential hash: the **manifest digest** (`sha256(canonical(manifest))`) is
   the version identity and transitively commits to every artifact via the digests
   the manifest records; the publisher **signature is detached** (a separate
   attestation over the manifest digest), never embedded in the manifest. The
   manifest SHALL NOT contain its own hash or signature.
3. IF the manifest omits the `artifacts.wasm` entry THEN the plugin SHALL be treated
   as declarative-only (no sandbox is instantiated).
4. IF the manifest `api` version is unsupported by the host THEN the host SHALL
   refuse to load the plugin and surface a clear error.
5. The manifest SHALL be the single source of truth for capability requests; a
   plugin SHALL NOT obtain any capability not declared in its manifest.

### Requirement 2 — Seam contract (the interception surface)
**User story:** As a plugin author, I want typed seams to transform the model
request, rewrite tool calls, and weigh in on permissions, so I can change agent
behaviour without forking the runtime.

#### Acceptance Criteria
1. The host SHALL define a versioned seam contract `carrier.plugin/v1` with seams:
   `before_step`, `tool_before`, `tool_after`, `permission_ask`, `session_start`,
   `session_end`. A plugin MAY implement any subset.
2. Each seam SHALL be invoked with a JSON input and SHALL return a JSON
   **patch/decision** (return-new); the host SHALL NOT expose mutable host state to
   the plugin (the immutable, return-new model — never in-place mutation).
3. `before_step` SHALL allow: appending to the system prompt, overriding model and
   effort (subject to policy clamps), and filtering the visible tool set. It SHALL
   NOT permit arbitrary rewriting of conversation history in v1.
4. `tool_before` SHALL allow: a decision of `allow|deny|ask`, an optional rewritten
   tool input, and appended context. `tool_after` SHALL allow: an optional result
   override and appended context.
5. `permission_ask` SHALL allow a decision of `deny|ask|abstain` by default; a
   decision of `allow` SHALL be honoured ONLY if the operator granted the plugin
   the explicit `permissions.allow` opt-in at install time, otherwise it SHALL be
   downgraded to `ask`.
6. WHEN multiple plugins implement the same seam THEN the host SHALL invoke them in
   a deterministic order and fold their patches; a `deny` decision SHALL be
   terminal (short-circuit), mirroring the existing hook chain.

### Requirement 3 — WASM sandbox & capability model
**User story:** As the platform operator, I want plugin code to run with zero
ambient authority and only the capabilities it was granted, so one tenant's plugin
can never reach another tenant's data or the host.

#### Acceptance Criteria
1. Plugin code SHALL execute as WebAssembly in a wazero runtime with NO ambient
   filesystem, network, or process access.
2. The host SHALL expose capabilities only as explicit host-function imports, each
   gated by the manifest AND operator approval: `log`, `http_fetch` (restricted to
   manifest-declared hosts, size/rate limited), `kv_get`/`kv_set` (namespaced per
   plugin and owning scope), and `secret_get` (restricted to manifest-declared keys,
   resolved from the existing secret store).
3. The host SHALL enforce a per-call wall-clock deadline (epoch-based interruption)
   and a memory limit per plugin instance.
4. IF a seam call exceeds its deadline, traps, or returns an invalid patch THEN the
   host SHALL disable that plugin for the remainder of the session, emit an
   observability event, and apply fail-closed semantics (see Req 7).
5. A plugin instance SHALL be per-session; its `kv`/`secret` namespaces SHALL be
   scoped to `(plugin, owner)` so no cross-tenant or cross-plugin access is possible.

### Requirement 4 — Marketplace registry & signing
**User story:** As a user, I want to discover, install, and trust plugins from a
registry, so I can extend my sessions safely.

#### Acceptance Criteria
1. The registry SHALL support publish, search, list-versions, and download of plugin
   bundles; each version SHALL be identified by an immutable **manifest digest**
   (`sha256(canonical(manifest))`), which transitively commits to every artifact via
   the digests recorded in the manifest.
2. At launch the registry SHALL accept publishes ONLY from **verified publishers**;
   a publisher SHALL be identified by a registered signing key, and publish SHALL
   verify the detached signature over the manifest digest against that key.
3. WHEN a bundle is installed OR loaded THEN the system SHALL: recompute the manifest
   digest, verify the **detached** publisher signature over it, AND verify each
   loaded artifact's bytes against the digest recorded in the manifest; any mismatch
   SHALL abort the operation.
4. The registry SHALL be reachable only through the BFF (browser↔BFF only); the
   browser SHALL never talk to the registry or fetch unverified artifacts directly.

### Requirement 5 — Install, scope & capability consent
**User story:** As an org owner/admin, I want to install a plugin at org or project
scope and explicitly approve the capabilities it requests, so nothing runs with
authority I didn't grant.

#### Acceptance Criteria
1. A plugin SHALL be installable at **org** or **project** scope (reusing the
   existing config scope model); installation SHALL require a manager role
   (owner/admin), mirroring existing config mutations.
2. WHEN installing THEN the UI SHALL present every requested capability (network
   hosts, secret keys, seams, `permissions.allow` opt-in) and SHALL require explicit
   approval; ungranted capabilities SHALL be denied at runtime.
3. The install record SHALL pin the exact `version` + `manifest_digest` (a lockfile);
   an upgrade SHALL be an explicit action that re-presents any newly requested
   capabilities for re-consent.
4. An org SHALL be able to restrict installable plugins to an allowlist; a plugin
   not permitted by org policy SHALL NOT be installable in that org's projects.

### Requirement 6 — Integration with session assembly & runtime
**User story:** As a developer, I want an installed plugin to take effect on the
next session automatically, so install is the only action required.

#### Acceptance Criteria
1. WHEN a session is created THEN the BFF SHALL merge installed plugins' declarative
   layers into the assembled `SessionConfig` (org layer then project layer; explicit
   per-scope config still overrides), AND SHALL include the active plugins' refs
   ({name, version, manifest_digest, wasm_digest}) so the runtime can load them.
2. WHEN the runtime builds a session THEN it SHALL resolve each active plugin's WASM
   by its `wasm_digest` (with a local content-addressed cache), verify it against the
   manifest's recorded digest, instantiate it sandboxed,
   and register its seams into the session's middleware chain.
3. The plugin seams SHALL be invoked at the existing runtime points: `before_step`
   when a turn's `StepInput` is built; `tool_before`/`tool_after` around tool
   dispatch; `permission_ask` during permission evaluation; `session_start`/`_end`
   at session lifecycle boundaries.
4. A plugin-contributed permission rule SHALL only be able to RESTRICT (deny/ask)
   unless the operator granted `permissions.allow`; it SHALL never silently
   escalate authority (consistent with layer-aware trust — project/plugin layers
   cannot grant trust).

### Requirement 7 — Multi-tenant safety & fail-closed semantics
**User story:** As the platform operator, I want a misbehaving plugin to never
stall, crash, or weaken a session, so tenant isolation and availability hold.

#### Acceptance Criteria
1. A plugin trap, timeout, or invalid output SHALL NOT crash the session goroutine;
   it SHALL be contained, logged, and the plugin disabled for the session.
2. On `permission_ask` failure/timeout the host SHALL fall back to the existing
   `perm.Policy` decision (NEVER auto-allow); on `tool_before`/`tool_after`/
   `before_step` failure the host SHALL treat the seam as a no-op and continue.
3. The host SHALL bound aggregate plugin resource usage per session (CPU time via
   deadlines, memory via instance limits) so plugins cannot exhaust the fleet.
4. All plugin invocations and their outcomes SHALL be observable (spans/events) for
   audit, including WHY a tool/permission decision was influenced by a plugin.

### Requirement 8 — Plugin developer experience
**User story:** As a plugin author, I want a clear SDK and local testing path, so I
can build and validate a plugin without the full platform.

#### Acceptance Criteria
1. The project SHALL document the `carrier.plugin/v1` seam contract and provide a
   reference plugin (built from TinyGo or Rust to WASM) implementing each seam.
2. The host package SHALL be testable in isolation: a test SHALL load a sample WASM
   plugin, invoke each seam, and assert the resulting patch/decision and the
   enforcement of capabilities, deadlines, and fail-closed behaviour.
3. The manifest schema SHALL be published so authors can validate a bundle before
   publishing.
