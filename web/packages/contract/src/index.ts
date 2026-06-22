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
  z.object({ seq: z.number(), kind: z.literal("error"), message: z.string() }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// ── Session input / approvals ─────────────────────────────────────────────────

export const SendInputSchema = z.object({
  text: z.string().min(1),
  steer: z.boolean().optional(),
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
