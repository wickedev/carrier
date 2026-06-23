// PGlite-backed Drizzle client. createDb() spins up an in-memory PGlite (or a
// file-backed one when a path is given) and bootstraps the schema with
// CREATE TABLE IF NOT EXISTS so neither tests nor first boot require drizzle-kit
// migration files at runtime.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

const DDL = `
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  github_user_id TEXT UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT NOT NULL,
  email TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS org (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  github_org_id TEXT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS membership (
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS github_installation (
  id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  suspended BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false,
  base_path TEXT NOT NULL,
  repo_bound BOOLEAN NOT NULL DEFAULT false,
  repo_full_name TEXT,
  repo_default_branch TEXT,
  installation_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  carrier_session_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  plan_mode BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false,
  working_copy_path TEXT NOT NULL,
  working_branch TEXT,
  forked_from_rev TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS permission_rule (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  pattern TEXT NOT NULL,
  effect TEXT NOT NULL,
  source TEXT
);
CREATE TABLE IF NOT EXISTS config_agent (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT
);
CREATE TABLE IF NOT EXISTS config_skill (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  agent TEXT,
  allowed_tools TEXT
);
CREATE TABLE IF NOT EXISTS config_mcp (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL,
  env_keys TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_context (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  name TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_hook (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  name TEXT NOT NULL,
  event TEXT NOT NULL,
  command TEXT NOT NULL,
  matcher TEXT
);
CREATE TABLE IF NOT EXISTS config_env (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  key TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  secret BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS config_model_params (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  max_steps INTEGER NOT NULL DEFAULT 0,
  context_budget INTEGER NOT NULL DEFAULT 0,
  plan_mode BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (scope, owner_id)
);
CREATE TABLE IF NOT EXISTS plugin_publisher (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plugin (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  publisher_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  latest_version TEXT
);
CREATE TABLE IF NOT EXISTS plugin_version (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  wasm_digest TEXT,
  artifact_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, version)
);
CREATE TABLE IF NOT EXISTS plugin_install (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  plugin_name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  granted_caps_json TEXT NOT NULL,
  allow_permissions BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS org_plugin_allowlist (
  org_id TEXT NOT NULL,
  plugin_name TEXT NOT NULL
);
`;

// Idempotent migrations applied after the CREATE TABLE bootstrap so existing
// databases (a persisted dev PGlite or a production Postgres) converge to the
// current schema — CREATE TABLE IF NOT EXISTS never alters an existing table.
// Every statement is safe to re-run.
export const MIGRATIONS = `
-- email/password auth: github_user_id becomes optional + a password hash column.
ALTER TABLE account ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE account ALTER COLUMN github_user_id DROP NOT NULL;
-- Enforce a single account per email FOR PASSWORD ACCOUNTS (login identity).
-- A partial unique index leaves GitHub accounts (which may share or omit an
-- email) unconstrained while making duplicate registrations impossible.
CREATE UNIQUE INDEX IF NOT EXISTS account_password_email_unique
  ON account (email) WHERE password_hash IS NOT NULL;
`;

export interface CreateDbOptions {
  /** Filesystem path / data dir for PGlite; omit for in-memory (tests). */
  dataDir?: string;
}

export async function createDb(opts: CreateDbOptions = {}): Promise<Db> {
  const pg = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  await pg.exec(DDL);
  await pg.exec(MIGRATIONS);
  return drizzle(pg, { schema });
}

export { schema };
