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
  github_user_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT NOT NULL,
  email TEXT,
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
`;

export interface CreateDbOptions {
  /** Filesystem path / data dir for PGlite; omit for in-memory (tests). */
  dataDir?: string;
}

export async function createDb(opts: CreateDbOptions = {}): Promise<Db> {
  const pg = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  await pg.exec(DDL);
  return drizzle(pg, { schema });
}

export { schema };
