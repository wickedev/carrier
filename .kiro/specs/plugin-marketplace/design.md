# Plugin Marketplace — Design

## Overview

Three concerns, cleanly separated:

1. **Seam host** (`internal/plugin`, Go) — the runtime side: a typed middleware
   chain woven into the Flight loop that invokes plugin seams (`before_step`,
   `tool_before`, `tool_after`, `permission_ask`, `session_start/end`). First-party
   Go middleware and sandboxed WASM plugins implement the same `Seam` interface.
2. **WASM sandbox** (`internal/plugin/wasm`, wazero) — runs untrusted plugin code
   with zero ambient authority, capability host-functions, per-call deadlines, and
   memory limits.
3. **Marketplace** (BFF + registry) — publish/sign/verify/install; install records
   feed the existing `config-assembly` (declarative layer) and the new active-plugin
   refs included in `SessionConfig`.

```
author → bundle(manifest + wasm + declarative) → [registry: verified publish, signed]
user (web) → BFF → install (org/project scope, capability consent, lockfile)
session create → config-assembly merges declarative layer + active refs
  → Carrier resolves wasm by digest (cache, verified) → wazero instances per session
  → seams registered in Flight middleware chain
```

Reuses: `config-assembly` (org+project merge), `internal/mcp` (out-of-process
pattern), `internal/bay` (OS sandbox, if a subprocess fallback is ever added),
`internal/hook` (return-new middleware), `internal/perm` (policy), the secret store.

---

## The seam contract — `carrier.plugin/v1`

All seams are request/response with JSON; the plugin returns a **patch/decision**,
never mutates host state. Wire shapes (snake_case), host-Go mirror types below.

```
before_step
  in : { session_id, step: { system, message_count, tools: [name], model, effort } }
  out: { system_append?: string, model?: string, effort?: string,
         tools_deny?: [name], tools_allow_only?: [name] }

tool_before
  in : { session_id, call_id, tool, input: <json> }
  out: { decision: "allow"|"deny"|"ask", reason?: string,
         rewritten_input?: <json>, context_append?: string }

tool_after
  in : { session_id, call_id, tool, input: <json>, result: { content, is_error } }
  out: { result_override?: { content: string }, context_append?: string }

permission_ask
  in : { session_id, action, resource }
  out: { decision: "allow"|"deny"|"ask"|"abstain", reason?: string }
       // "allow" honoured only if operator granted permissions.allow, else → "ask"

session_start | session_end
  in : { session_id, meta: { project_id, ... } }
  out: { context_append?: string }
```

### Go host interface

```go
package plugin

// Seam is implemented by every plugin backend (native Go or WASM). A plugin
// registers itself for the seams it supports; unimplemented seams are skipped.
type Seam interface {
    Name() string                  // plugin name@version
    Supports(s SeamKind) bool

    BeforeStep(ctx context.Context, in BeforeStepInput) (BeforeStepPatch, error)
    ToolBefore(ctx context.Context, in ToolBeforeInput) (ToolBeforeDecision, error)
    ToolAfter(ctx context.Context, in ToolAfterInput) (ToolAfterPatch, error)
    PermissionAsk(ctx context.Context, in PermissionInput) (PermissionDecision, error)
    SessionStart(ctx context.Context, in LifecycleInput) (LifecyclePatch, error)
    SessionEnd(ctx context.Context, in LifecycleInput) (LifecyclePatch, error)
}

// Chain folds an ordered set of Seams. It is the single object the Flight loop
// talks to; folding rules and fail-closed semantics live here (Req 2.6, 7.2).
type Chain struct { seams []Seam /* ... */ }

func (c *Chain) BeforeStep(ctx, *agent.StepInput) error      // mutates the StepInput the host owns
func (c *Chain) ToolBefore(ctx, call) (Decision, error)       // allow/deny/ask + rewrite
func (c *Chain) ToolAfter(ctx, call, *agent.ToolResult) error
func (c *Chain) PermissionAsk(ctx, action, resource) (perm.Effect, bool) // bool=had opinion
func (c *Chain) SessionStart/SessionEnd(ctx, meta) (contextAppend string)
```

Folding rules (in `Chain`):
- `before_step`: apply each plugin's patch in order; `system_append` concatenated,
  `model`/`effort` last-non-empty wins **after** the host clamps to allowed values
  (effort clamped per provider as in `openAIReasoningEffort`); tool filters
  intersected.
- `tool_before`: first `deny` short-circuits (terminal); `rewritten_input` threaded
  to the next plugin; `context_append` accumulated.
- `permission_ask`: any `deny` is terminal; `allow` only if opted-in else `ask`;
  if all `abstain`/fail → return "no opinion" so the host falls through to
  `perm.Policy`.

### Flight loop integration (the wiring)

`internal/flight`:
- `Config` gains `Plugins *plugin.Chain` (nil → no plugins).
- `runTurn`: after building `in := agent.StepInput{...}`, call
  `f.plugins.BeforeStep(ctx, &in)` before `engine.RunStep`.
- tool dispatch (`tool.Dispatch` site): wrap each call with `ToolBefore`
  (deny/ask/rewrite) and `ToolAfter` (override/context). This reuses and finally
  wires the existing `internal/hook` PreToolUse/PostToolUse seam that is defined
  but not yet woven into the loop.
- permission evaluation: `PermissionAsk` consulted before the Approver, layered with
  `perm.Policy` (plugin can only deny/ask unless opted-in).
- `SessionStart`/`SessionEnd` at Run() boundaries; their `context_append` folds into
  durable memory / a system note.

First-party Go middleware and WASM plugins both implement `Seam`, so the Flight
loop is agnostic to the backend.

---

## WASM host (`internal/plugin/wasm`, wazero)

```go
type Host struct {
    rt       wazero.Runtime          // shared, with compilation cache
    limits   Limits                  // memory pages, per-call deadline
    caps     CapabilityBroker        // log / http_fetch / kv / secret_get
}

// Compile once (per plugin artifact), instantiate per session.
func (h *Host) Compile(ref Ref, wasm []byte) (*Module, error)
func (m *Module) Instance(ctx, grant CapabilityGrant) (*Instance, error) // per session
func (i *Instance) Invoke(ctx, seam SeamKind, inputJSON []byte) ([]byte, error)
```

- **Runtime**: `wazero.NewRuntimeWithConfig` with the compilation cache; no WASI
  filesystem/clock/args unless explicitly granted (we expose a minimal WASI subset
  or none — capabilities come through our own host-function imports).
- **ABI**: the guest exports `alloc`, `dealloc`, and one entry per seam
  (`before_step`, ...) taking a (ptr,len) JSON input and returning a (ptr,len) JSON
  output. The host module `carrier` exports the capability functions. (A reference
  guest SDK for TinyGo/Rust hides this ABI.)
- **Deadlines**: each `Invoke` runs under a context with a wall-clock deadline; the
  runtime is configured with `WithCloseOnContextDone` / epoch interruption so a
  runaway guest is interrupted, not merely abandoned.
- **Memory**: per-instance memory limit (max pages); the broker bounds `http_fetch`
  body size and call rate.
- **Capabilities (`CapabilityBroker`)** — host functions, each checks the
  instance's `CapabilityGrant`:
  - `log(level, ptr, len)`
  - `http_fetch(reqPtr, reqLen) → (respPtr, respLen)` — host enforces allowed-host
    allowlist, timeout, size cap.
  - `kv_get/kv_set` — namespaced `(plugin, owner)` store (Postgres/PGlite via the BFF
    or a runtime-local store).
  - `secret_get(keyPtr, keyLen) → val` — only manifest-declared keys, resolved from
    the secret store; values never logged.
- **Isolation**: one `Instance` per (session, plugin); grants and namespaces carry
  the owner scope so no cross-tenant reach (Req 3.5, 7).

WASM is a `Seam` adapter: `wasmSeam{inst}` marshals the typed Go input → JSON →
`Invoke` → unmarshal patch; on error/timeout returns a typed error the `Chain`
turns into fail-closed behaviour.

---

## Marketplace, registry & trust

### Bundle, manifest & attestation
A bundle is a tarball of `carrier-plugin.json` + optional `plugin.wasm` +
declarative assets. **Integrity and signature are kept OUT of the manifest** to
avoid a self-referential hash (a manifest cannot contain a hash/signature of a
bundle that includes the manifest). The scheme is the standard OCI/Sigstore shape:

- The **manifest commits to every artifact it references by digest** (e.g. the
  WASM file). The manifest hashing a file it points to is not circular.
- The **manifest digest** is the plugin-version identity:
  `manifest_digest = sha256(canonical(carrier-plugin.json))`. Because the manifest
  embeds each artifact's digest, the manifest digest transitively commits to the
  whole bundle.
- The **signature is detached**: a separate `carrier-plugin.sig` (and/or a registry
  field) carrying the publisher's signature over `manifest_digest`. It is never
  stored inside the manifest.

Manifest (validated by a published JSON Schema) — note: no integrity/signature
fields inside it:

```jsonc
{
  "name": "...", "version": "1.2.0", "publisher": "acme",
  "api": "carrier.plugin/v1",
  "description": "...",
  "seams": ["tool_before", "before_step"],
  "capabilities": {
    "network": ["api.acme.com"],
    "secrets": ["ACME_TOKEN"],
    "kv": true,
    "permissions": { "allow": false }   // may the plugin grant allow? default false
  },
  "declarative": { /* skills, agents, mcp, context, hooks, permissions, model */ },
  "artifacts": {
    "wasm": { "path": "plugin.wasm", "digest": "sha256-<wasm-bytes>" }
    // any external declarative asset is likewise listed with its digest;
    // inline declarative config is already covered by the manifest bytes
  }
}
```

Detached attestation (alongside the bundle, e.g. `carrier-plugin.sig`):
```jsonc
{ "manifest_digest": "sha256-<manifest>", "publisher": "acme",
  "signature": "<sig over manifest_digest>", "alg": "ed25519" }
```

**Verification (publish, install, and every runtime load):**
1. Recompute `manifest_digest = sha256(canonical(manifest))`.
2. Verify the detached signature over `manifest_digest` against the publisher's
   registered key; reject on mismatch.
3. For each referenced artifact, verify its bytes against the `digest` recorded in
   the manifest (so the WASM the runtime loads is exactly what was signed).

### Registry (BFF-brokered)
- Endpoints (BFF): `GET /marketplace/plugins` (search), `GET /marketplace/plugins/:name/versions`,
  `GET /marketplace/plugins/:name/:version` (manifest + detached signature + artifact refs).
  Browser↔BFF only.
- **Verified publishers**: a `publisher` table with a registered public key and a
  `verified` flag; at launch only `verified` publishers may publish. Publish
  verifies the detached signature over the manifest digest against the publisher key.
- **Identity = manifest digest**: every version is pinned by its immutable
  `manifest_digest`; the manifest in turn pins each artifact by its own digest.
  Both are re-verified on install and on every runtime load.

### Install (org/project scope)
- `POST /orgs/:org/plugins` / `POST /projects/:id/plugins` — manager-gated; body
  pins `{name, version}`, records granted capabilities + `permissions.allow` opt-in,
  and writes a **lockfile** (version + `manifest_digest`).
- Capability consent: the UI renders the manifest's requested capabilities; install
  persists exactly what the operator approved. Ungranted caps are denied at runtime.
- Org allowlist: an org policy table may restrict installable plugins; enforced in
  the install route.
- Upgrade is explicit and re-presents newly requested capabilities for re-consent.

### Data model (new tables, snake_case)
- `publisher(id, name, public_key, verified, created_at)`
- `plugin(id, name, publisher_id, latest_version)`
- `plugin_version(id, plugin_id, version, manifest_digest, manifest_json,
   signature, wasm_digest, artifact_ref, created_at)`
   — `manifest_digest` = version identity; `wasm_digest` mirrors
   `manifest.artifacts.wasm.digest` for fast runtime lookup; `signature` is the
   detached publisher signature over `manifest_digest`.
- `plugin_install(id, scope, owner_id, plugin_name, version, manifest_digest,
   granted_caps_json, allow_permissions, enabled, created_at)`
- `plugin_kv(plugin_name, owner_scope, owner_id, key, value)` — namespaced store.

### Assembly & runtime resolution
- `config-assembly` gains a step: load enabled `plugin_install` rows for the org +
  project, merge each plugin's `declarative` layer (org then project) into the
  existing `SessionConfig` layering (explicit per-scope config still wins).
- `SessionConfig` gains `plugins: [{ name, version, manifest_digest, wasm_digest,
  granted_caps }]` for active plugins; `carrier-client.createSession` forwards it;
  Carrier `SessionOptions` gains the matching field.
- Carrier resolves each active plugin's WASM **by its `wasm_digest`** from a
  content-addressed cache; a cache miss fetches the manifest + detached signature +
  WASM (through the BFF / artifact store) and runs the full verification (recompute
  manifest digest → verify detached signature → verify WASM bytes against
  `manifest.artifacts.wasm.digest`) before instantiating.

---

## Security model (summary)

| Threat | Mitigation |
|---|---|
| Plugin reads another tenant's data | per-session instance; kv/secret namespaced by (plugin, owner); no ambient fs/net |
| Plugin exfiltrates via network | `http_fetch` allowlist from manifest + operator consent; size/rate caps |
| Plugin stalls the fleet | per-call deadline (epoch interrupt) + memory cap + aggregate session bound |
| Plugin crashes the session | trap contained → plugin disabled for session, session continues |
| Plugin escalates authority | permission `allow` requires explicit opt-in; otherwise deny/ask only (layer-aware trust) |
| Supply-chain tampering | verified publishers, signature + integrity verified on install AND load; lockfile pin |
| Malicious upgrade | explicit upgrade + re-consent for new capabilities |

Fail-closed defaults: `permission_ask` failure → fall through to `perm.Policy`
(never auto-allow); other seam failures → no-op.

---

## Reference SDK & testing
- A reference guest SDK (TinyGo and Rust) wraps the ABI so authors write typed seam
  handlers. A sample plugin implementing every seam ships in the repo and is the
  fixture for host tests.
- Host tests load the sample WASM, drive each seam, and assert: patch correctness,
  capability enforcement (denied cap → error), deadline interruption, trap
  containment, and fail-closed permission fallback.
