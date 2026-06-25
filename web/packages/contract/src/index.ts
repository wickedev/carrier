// @carrier/contract — the single source of truth for BFF request/response shapes
// and the session event stream. Both apps/web and apps/bff import these zod
// schemas and the types inferred from them.
import { z } from "zod";

// ── Identity & org ────────────────────────────────────────────────────────────

export const RoleSchema = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof RoleSchema>;

export const AccountSchema = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().url(),
});
export type Account = z.infer<typeof AccountSchema>;

export const OrgSchema = z.object({
  id: z.string(),
  kind: z.enum(["org", "personal"]),
  slug: z.string(),
  name: z.string(),
  role: RoleSchema,
});
export type Org = z.infer<typeof OrgSchema>;

export const MeSchema = z.object({
  account: AccountSchema,
  orgs: z.array(OrgSchema),
});
export type Me = z.infer<typeof MeSchema>;

// ── Email/password auth ───────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

// ── Projects, workspace, sessions ─────────────────────────────────────────────

export const RepoBindingSchema = z.object({
  repoFullName: z.string(),
  defaultBranch: z.string(),
  installationId: z.number(),
});
export type RepoBinding = z.infer<typeof RepoBindingSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  slug: z.string(),
  name: z.string(),
  archived: z.boolean(),
  repo: RepoBindingSchema.nullable(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const SessionStatusSchema = z.enum(["idle", "running", "terminated"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// Per-session working-copy git state (see web-client design: per-session
// isolation; the working copy is forked from the Project base, never shared).
export const WorkingCopyStateSchema = z.object({
  branch: z.string().nullable(),
  dirty: z.boolean(),
  ahead: z.number(),
  behind: z.number(),
});
export type WorkingCopyState = z.infer<typeof WorkingCopyStateSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: SessionStatusSchema,
  planMode: z.boolean(),
  workingCopy: WorkingCopyStateSchema.nullable(),
  createdAt: z.string(),
  archived: z.boolean(),
});
export type Session = z.infer<typeof SessionSchema>;

export const CreateProjectSchema = z.object({ name: z.string().min(1) });
export const CreateSessionSchema = z.object({
  title: z.string().min(1).optional(),
  planMode: z.boolean().optional(),
});
export const BindRepoSchema = z.object({
  installationId: z.number(),
  repoFullName: z.string(),
  defaultBranch: z.string().optional(),
});

// ── Files / tree / diff (session-scoped working copy) ─────────────────────────

export const GitStatusSchema = z.enum(["A", "M", "D", "U", "clean"]); // U = untracked
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const TreeEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(["file", "dir"]),
  git: GitStatusSchema.optional(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const FileDiffSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

// ── Session event stream (mirrors Carrier StreamEvent, BFF-normalized) ────────

export const SessionEventSchema = z.discriminatedUnion("kind", [
  z.object({ seq: z.number(), kind: z.literal("text"), text: z.string() }),
  z.object({ seq: z.number(), kind: z.literal("reasoning"), text: z.string() }),
  z.object({
    seq: z.number(),
    kind: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    seq: z.number(),
    kind: z.literal("tool_result"),
    id: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    seq: z.number(),
    kind: z.literal("file_changed"),
    path: z.string(),
    status: GitStatusSchema,
  }),
  z.object({
    seq: z.number(),
    kind: z.literal("approval_request"),
    reqId: z.string(),
    tool: z.string(),
    resource: z.string(),
    reason: z.string(),
  }),
  z.object({
    seq: z.number(),
    kind: z.literal("status"),
    state: SessionStatusSchema,
  }),
  // Auto-generated session title (emitted once after the first turn).
  z.object({ seq: z.number(), kind: z.literal("title"), title: z.string() }),
  z.object({ seq: z.number(), kind: z.literal("error"), message: z.string() }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// ── Session input / approvals ─────────────────────────────────────────────────

/** Reasoning-effort levels ("" = the engine/provider default). */
export const EffortSchema = z.enum(["", "low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const SendInputSchema = z.object({
  text: z.string().min(1),
  steer: z.boolean().optional(),
  // Optional per-turn overrides of the session-default model params. Absent =
  // use the session default. `model` empty/absent means "session default".
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  planMode: z.boolean().optional(),
});
export const ApprovalDecisionSchema = z.object({ allow: z.boolean() });

// ── Usage / cost ──────────────────────────────────────────────────────────────

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
});
export type Usage = z.infer<typeof UsageSchema>;

// ── Permissions ───────────────────────────────────────────────────────────────

export const PermissionRuleSchema = z.object({
  id: z.string(),
  action: z.string(),
  pattern: z.string(),
  effect: z.enum(["allow", "deny", "ask"]),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

// ── Configuration primitives (agents / skills / MCP / context / hooks / env) ──
//
// All four config families plus hooks and env live at TWO scopes: an Org-level
// shared layer and a Project-level layer that adds to / overrides it. Every row
// carries a `scope` discriminator + the owning id (`orgId` or `projectId`); the
// effective config for a session is the org layer merged with the project layer
// (project wins on name collision). These are the single source of truth shared
// by the BFF (storage + REST) and the web UI; the BFF also assembles them into
// the SessionConfig handed to Carrier at session creation.

export const ConfigScopeSchema = z.enum(["org", "project"]);
export type ConfigScope = z.infer<typeof ConfigScopeSchema>;

/** A named subagent definition (a custom "agent" the model can delegate to). */
export const AgentDefSchema = z.object({
  id: z.string(),
  scope: ConfigScopeSchema,
  name: z.string().min(1),
  description: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  enabled: z.boolean(),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;

/** A skill: name + description (shown to the model) + body (loaded on demand). */
export const SkillDefSchema = z.object({
  id: z.string(),
  scope: ConfigScopeSchema,
  name: z.string().min(1),
  description: z.string(),
  body: z.string(),
  /** Restrict to a single agent (empty → any). */
  agent: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  enabled: z.boolean(),
});
export type SkillDef = z.infer<typeof SkillDefSchema>;

/** An MCP server registration (stdio transport). */
export const McpServerSchema = z.object({
  id: z.string(),
  scope: ConfigScopeSchema,
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  /** Names of env keys this server needs; values come from the secret store. */
  envKeys: z.array(z.string()),
  enabled: z.boolean(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/** A context document (AGENTS.md-like instructions injected into the session). */
export const ContextDocSchema = z.object({
  id: z.string(),
  scope: ConfigScopeSchema,
  name: z.string().min(1),
  body: z.string(),
  enabled: z.boolean(),
});
export type ContextDoc = z.infer<typeof ContextDocSchema>;

export const HookEventSchema = z.enum([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
]);
export type HookEvent = z.infer<typeof HookEventSchema>;

/** A command hook fired on a lifecycle event (matcher scopes tool events). */
export const HookDefSchema = z.object({
  id: z.string(),
  scope: ConfigScopeSchema,
  name: z.string().min(1),
  event: HookEventSchema,
  command: z.string().min(1),
  /** Glob over the tool name for Pre/PostToolUse (empty → all). */
  matcher: z.string().optional(),
  enabled: z.boolean(),
});
export type HookDef = z.infer<typeof HookDefSchema>;

/** An environment variable / secret. `secret` values are write-only (never
 *  returned to the browser — read responses carry an empty value + `hasValue`). */
export const EnvVarSchema = z.object({
  id: z.string(),
  scope: ConfigScopeSchema,
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean(),
  hasValue: z.boolean(),
});
export type EnvVar = z.infer<typeof EnvVarSchema>;

/** Model + run parameters for a scope (a single row per scope). */
export const ModelParamsSchema = z.object({
  model: z.string(),
  effort: EffortSchema,
  maxSteps: z.number().int().min(0),
  contextBudget: z.number().int().min(0),
  planMode: z.boolean(),
});
export type ModelParams = z.infer<typeof ModelParamsSchema>;

// Input schemas (id/hasValue are server-assigned, so omitted from create bodies).
export const CreateAgentDefSchema = AgentDefSchema.omit({ id: true, scope: true });
export const CreateSkillDefSchema = SkillDefSchema.omit({ id: true, scope: true });
export const CreateMcpServerSchema = McpServerSchema.omit({ id: true, scope: true });
export const CreateContextDocSchema = ContextDocSchema.omit({ id: true, scope: true });
export const CreateHookDefSchema = HookDefSchema.omit({ id: true, scope: true });
export const CreateEnvVarSchema = EnvVarSchema.omit({
  id: true,
  scope: true,
  hasValue: true,
});

/**
 * The fully-resolved per-session configuration the BFF assembles (org⊕project,
 * enabled-only, secrets resolved) and sends to Carrier on session creation. This
 * mirrors the Carrier `POST /v1/sessions` JSON body (snake_cased on the wire by
 * the carrier-client) — it is the contract between the BFF and the runtime.
 */
export const SessionConfigSchema = z.object({
  context: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  maxSteps: z.number().optional(),
  contextBudget: z.number().optional(),
  planMode: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  mcpServers: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      }),
    )
    .optional(),
  skills: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        body: z.string(),
        agent: z.string().optional(),
        allowedTools: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  subagents: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        prompt: z.string(),
        model: z.string().optional(),
      }),
    )
    .optional(),
  hooks: z
    .array(
      z.object({
        name: z.string(),
        event: HookEventSchema,
        command: z.string(),
        matcher: z.string().optional(),
      }),
    )
    .optional(),
  permissions: z
    .array(
      z.object({
        action: z.string(),
        pattern: z.string(),
        effect: z.enum(["allow", "deny", "ask"]),
      }),
    )
    .optional(),
  // Active (WASM) plugins the runtime should load for this session. Refs only —
  // the runtime resolves the artifact by digest. Declarative plugin contributions
  // are merged into the fields above by the assembly step.
  plugins: z
    .array(
      z.object({
        name: z.string(),
        version: z.string(),
        manifestDigest: z.string(),
        wasmDigest: z.string(),
        grantedCaps: z.array(z.string()),
        allowPermissions: z.boolean(),
      }),
    )
    .optional(),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

// ── Plugin marketplace ────────────────────────────────────────────────────────
//
// A plugin is a signed bundle with an optional declarative layer (config it
// contributes) and an optional active layer (a WASM module implementing seams).
// Integrity is a detached attestation over the manifest digest — the manifest is
// NEVER self-hashed/-signed (it records each artifact's digest instead).

export const SeamKindSchema = z.enum([
  "before_step",
  "tool_before",
  "tool_after",
  "permission_ask",
  "session_start",
  "session_end",
]);
export type SeamKind = z.infer<typeof SeamKindSchema>;

/** The capabilities a plugin requests; each must be operator-approved at install. */
export const PluginCapabilitiesSchema = z.object({
  /** Allowed outbound hosts for http_fetch (empty → no network). */
  network: z.array(z.string()).default([]),
  /** Secret keys the plugin may read via secret_get. */
  secrets: z.array(z.string()).default([]),
  /** Whether the plugin may use the namespaced kv store. */
  kv: z.boolean().default(false),
  /** Whether the plugin's permission_ask "allow" may be honored (default false). */
  permissionsAllow: z.boolean().default(false),
});
export type PluginCapabilities = z.infer<typeof PluginCapabilitiesSchema>;

/** A reference to a bundled artifact, pinned by its own content digest. */
export const PluginArtifactSchema = z.object({
  path: z.string(),
  digest: z.string(), // sha256-...
});

/** The plugin manifest (carrier-plugin.json). Contains NO self hash/signature. */
export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  publisher: z.string().min(1),
  api: z.string(), // e.g. "carrier.plugin/v1"
  description: z.string().default(""),
  seams: z.array(SeamKindSchema).default([]),
  capabilities: PluginCapabilitiesSchema,
  /** Optional declarative layer — same shape as a SessionConfig contribution. */
  declarative: SessionConfigSchema.partial().optional(),
  /** Artifacts the manifest commits to by digest (e.g. the WASM module). */
  artifacts: z
    .object({ wasm: PluginArtifactSchema.optional() })
    .default({}),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** A marketplace listing (search/browse). */
export const MarketplacePluginSchema = z.object({
  name: z.string(),
  publisher: z.string(),
  verified: z.boolean(),
  description: z.string(),
  latestVersion: z.string(),
});
export type MarketplacePlugin = z.infer<typeof MarketplacePluginSchema>;

/** One published version, identified by its manifest digest. */
export const PluginVersionSchema = z.object({
  name: z.string(),
  version: z.string(),
  manifestDigest: z.string(),
  manifest: PluginManifestSchema,
  createdAt: z.string(),
});
export type PluginVersion = z.infer<typeof PluginVersionSchema>;

/** An installed plugin at org or project scope (the lockfile row). */
export const PluginInstallSchema = z.object({
  id: z.string(),
  scope: ConfigScopeSchema,
  name: z.string(),
  version: z.string(),
  manifestDigest: z.string(),
  grantedCaps: z.array(z.string()),
  allowPermissions: z.boolean(),
  enabled: z.boolean(),
});
export type PluginInstall = z.infer<typeof PluginInstallSchema>;

/** Install request: pin a version + the operator-approved capabilities. */
export const InstallPluginSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  grantedCaps: z.array(z.string()).default([]),
  allowPermissions: z.boolean().default(false),
});
export type InstallPlugin = z.infer<typeof InstallPluginSchema>;
