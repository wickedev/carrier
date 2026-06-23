// Environment configuration for the BFF. Sensible defaults are chosen so the
// app boots in tests/dev without any env set; production must override the
// secrets and the Carrier/GitHub credentials.

import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  databaseUrl?: string;
  carrierBaseUrl: string;
  carrierToken: string;
  githubClientId: string;
  githubClientSecret: string;
  githubAppId: string;
  githubPrivateKey: string;
  sessionSecret: string;
  workspaceRoot: string;
  /** When true the session cookie is marked Secure (https only). */
  secureCookies: boolean;
  /** Secret used to derive the AES-256-GCM key for config env encryption. */
  configSecretKey: string;
  /** Local directory for the content-addressed plugin artifact store. */
  pluginArtifactsRoot: string;
  /** Seed a known dev account on boot so local login works out of the box. */
  seedDevUser: boolean;
  devUserEmail: string;
  devUserPassword: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    port: Number(env("PORT", "8787")),
    databaseUrl: process.env.DATABASE_URL || undefined,
    carrierBaseUrl: env("CARRIER_BASE_URL", "http://localhost:9099"),
    carrierToken: env("CARRIER_TOKEN", "test-carrier-token"),
    githubClientId: env("GITHUB_CLIENT_ID", "test-client-id"),
    githubClientSecret: env("GITHUB_CLIENT_SECRET", "test-client-secret"),
    githubAppId: env("GITHUB_APP_ID", "123456"),
    githubPrivateKey: env("GITHUB_PRIVATE_KEY", "test-private-key"),
    // iron-session requires a secret of length >= 32.
    sessionSecret: env(
      "SESSION_SECRET",
      "test-session-secret-at-least-32-chars-long!!",
    ),
    workspaceRoot: env("WORKSPACE_ROOT", join(tmpdir(), "carrier-bff-workspace")),
    secureCookies: env("NODE_ENV", "test") === "production",
    // Dev default is a fixed 32-byte string; production must override this.
    configSecretKey: env(
      "CONFIG_SECRET_KEY",
      "carrier-dev-config-secret-key!!32",
    ),
    pluginArtifactsRoot: env(
      "PLUGIN_ARTIFACTS_ROOT",
      join(tmpdir(), "carrier-bff-plugin-artifacts"),
    ),
    // Seed a dev account outside production, unless explicitly disabled. This is
    // applied at server boot (index.ts), never in tests.
    seedDevUser:
      env("NODE_ENV", "test") !== "production" &&
      env("SEED_DEV_USER", "true") !== "false",
    devUserEmail: env("DEV_USER_EMAIL", "dev@carrier.local"),
    devUserPassword: env("DEV_USER_PASSWORD", "carrierdev"),
  };
  return { ...base, ...overrides };
}
