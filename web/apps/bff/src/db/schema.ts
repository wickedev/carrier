// Drizzle schema for the BFF control-plane (PGlite/Postgres). Mirrors the data
// model in the web-client design doc. The matching DDL bootstrap lives in
// db/client.ts (CREATE TABLE IF NOT EXISTS) so tests don't need migration files.

import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  githubUserId: text("github_user_id").notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url").notNull(),
  email: text("email"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const org = pgTable("org", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // 'org' | 'personal'
  githubOrgId: text("github_org_id"),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  ownerAccountId: text("owner_account_id").notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const membership = pgTable("membership", {
  accountId: text("account_id").notNull(),
  orgId: text("org_id").notNull(),
  role: text("role").notNull(), // 'owner' | 'admin' | 'member'
});

export const githubInstallation = pgTable("github_installation", {
  id: text("id").primaryKey(),
  installationId: integer("installation_id").notNull(),
  orgId: text("org_id").notNull(),
  accountLogin: text("account_login").notNull(),
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const project = pgTable("project", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  archived: boolean("archived").notNull().default(false),
  basePath: text("base_path").notNull(),
  repoBound: boolean("repo_bound").notNull().default(false),
  repoFullName: text("repo_full_name"),
  repoDefaultBranch: text("repo_default_branch"),
  installationId: integer("installation_id"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  carrierSessionId: text("carrier_session_id"),
  title: text("title").notNull(),
  status: text("status").notNull().default("idle"), // idle|running|terminated
  planMode: boolean("plan_mode").notNull().default(false),
  createdBy: text("created_by").notNull(),
  archived: boolean("archived").notNull().default(false),
  workingCopyPath: text("working_copy_path").notNull(),
  workingBranch: text("working_branch"),
  forkedFromRev: text("forked_from_rev"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const permissionRule = pgTable("permission_rule", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  action: text("action").notNull(),
  pattern: text("pattern").notNull(),
  effect: text("effect").notNull(), // 'allow' | 'deny' | 'ask'
  source: text("source"),
});

// ── Configuration tables (org+project-scoped) ───────────────────────────────
// Each config table carries scope ('org'|'project') + owner_id (the org id when
// scope=org, the project id when scope=project) + an enabled flag. The effective
// session config is the org layer merged with the project layer (project wins).

export const configAgent = pgTable("config_agent", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  name: text("name").notNull(),
  description: text("description").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model"),
});

export const configSkill = pgTable("config_skill", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  name: text("name").notNull(),
  description: text("description").notNull(),
  body: text("body").notNull(),
  agent: text("agent"),
  allowedTools: text("allowed_tools"), // JSON-encoded string[]
});

export const configMcp = pgTable("config_mcp", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  name: text("name").notNull(),
  command: text("command").notNull(),
  args: text("args").notNull(), // JSON-encoded string[]
  envKeys: text("env_keys").notNull(), // JSON-encoded string[]
});

export const configContext = pgTable("config_context", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  name: text("name").notNull(),
  body: text("body").notNull(),
});

export const configHook = pgTable("config_hook", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  name: text("name").notNull(),
  event: text("event").notNull(),
  command: text("command").notNull(),
  matcher: text("matcher"),
});

export const configEnv = pgTable("config_env", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  key: text("key").notNull(),
  valueEnc: text("value_enc").notNull(), // ciphertext (secret) or plaintext
  secret: boolean("secret").notNull().default(false),
});

export const configModelParams = pgTable("config_model_params", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").notNull(), // UNIQUE per (scope, owner_id)
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  maxSteps: integer("max_steps").notNull().default(0),
  contextBudget: integer("context_budget").notNull().default(0),
  planMode: boolean("plan_mode").notNull().default(false),
});

export type AccountRow = typeof account.$inferSelect;
export type OrgRow = typeof org.$inferSelect;
export type MembershipRow = typeof membership.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type PermissionRuleRow = typeof permissionRule.$inferSelect;
export type GithubInstallationRow = typeof githubInstallation.$inferSelect;
export type ConfigAgentRow = typeof configAgent.$inferSelect;
export type ConfigSkillRow = typeof configSkill.$inferSelect;
export type ConfigMcpRow = typeof configMcp.$inferSelect;
export type ConfigContextRow = typeof configContext.$inferSelect;
export type ConfigHookRow = typeof configHook.$inferSelect;
export type ConfigEnvRow = typeof configEnv.$inferSelect;
export type ConfigModelParamsRow = typeof configModelParams.$inferSelect;
