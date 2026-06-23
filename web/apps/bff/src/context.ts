// Shared app dependencies + Hono environment typing. createApp builds an AppDeps
// (db, config, carrier, github) and stashes it on c.var so every route handler
// can reach it; the auth middleware also sets c.var.account.

import type { CarrierClient } from "@carrier/carrier-client";
import type { Db } from "./db/client.js";
import type { Config } from "./config.js";
import type { GithubProvider } from "./auth/github-provider.js";
import type { AccountRow } from "./db/schema.js";
import type { Workspace } from "./workspace/workspace.js";
import type { UsageStore } from "./usage.js";
import type { LogLine } from "./logging.js";
import type { ConfigCrypto } from "./crypto.js";
import type { PluginArtifactStore } from "./plugin-artifacts.js";

export interface AppDeps {
  db: Db;
  config: Config;
  github: GithubProvider;
  workspace: Workspace;
  /** Factory so tests can inject a fake-fetch-backed CarrierClient. */
  carrier: () => CarrierClient;
  /** In-memory per-session usage/cost tally (accumulated by the SSE relay). */
  usage: UsageStore;
  /** AES-256-GCM helper for config env secrets (encrypt/decrypt). */
  crypto: ConfigCrypto;
  /** Content-addressed store for published plugin WASM artifacts. */
  pluginArtifacts: PluginArtifactStore;
  /** Optional structured-log sink (tests capture lines; prod uses console). */
  logSink?: (line: LogLine) => void;
}

export interface AppEnv {
  Variables: {
    deps: AppDeps;
    account: AccountRow;
  };
}
