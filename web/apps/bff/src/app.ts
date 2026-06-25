// createApp builds the BFF Hono application and mounts the control-plane:
// auth (GitHub OAuth + session), /me, orgs, projects (+ repo bind + sessions +
// permissions), sessions (tree/file/diff, input/interrupt, SSE relay,
// approvals, promote), and GitHub installations.

import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./context.js";
import { loadConfig, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import {
  OctokitGithubProvider,
  StubGithubProvider,
  isGithubAppConfigured,
} from "./auth/github-provider.js";
import { createCarrierClient } from "./carrier.js";
import { Workspace } from "./workspace/workspace.js";
import { UsageStore } from "./usage.js";
import { createConfigCrypto } from "./crypto.js";
import { PluginArtifactStore } from "./plugin-artifacts.js";
import { requestLogger } from "./logging.js";
import { authRoutes, meRoute, requireAuth } from "./auth/index.js";
import { orgRoutes } from "./routes/orgs.js";
import { projectRoutes } from "./routes/projects.js";
import { sessionRoutes } from "./routes/sessions.js";
import { githubRoutes } from "./routes/github.js";
import { configRoutes } from "./routes/config.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { pluginInstallRoutes } from "./routes/plugin-install.js";

/** Build the full set of app dependencies for production/dev startup. */
export async function createDeps(
  overrides: Partial<AppDeps> & { config?: Config } = {},
): Promise<AppDeps> {
  const config = overrides.config ?? loadConfig();
  const db = overrides.db ?? (await createDb({ dataDir: config.databaseUrl }));
  // Without real GitHub App credentials (local dev), Octokit can't sign its JWT
  // and every installations call would 500; fall back to a stub that reports no
  // installations so GitHub features degrade gracefully instead of erroring.
  let github = overrides.github;
  if (!github) {
    if (isGithubAppConfigured(config)) {
      github = new OctokitGithubProvider(config);
    } else {
      console.warn(
        "[bff] GitHub App not configured (no GITHUB_PRIVATE_KEY); using stub provider — installations will be empty.",
      );
      github = new StubGithubProvider();
    }
  }
  const workspace =
    overrides.workspace ?? new Workspace(config.workspaceRoot, github);
  const carrier = overrides.carrier ?? (() => createCarrierClient(config));
  const usage = overrides.usage ?? new UsageStore();
  const crypto = overrides.crypto ?? createConfigCrypto(config);
  const pluginArtifacts =
    overrides.pluginArtifacts ??
    new PluginArtifactStore(config.pluginArtifactsRoot);
  return {
    db,
    config,
    github,
    workspace,
    carrier,
    usage,
    crypto,
    pluginArtifacts,
    logSink: overrides.logSink,
  };
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject deps onto every request.
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  // Structured request logging (secrets redacted). A custom sink can be injected
  // for tests via deps.logSink.
  app.use("*", requestLogger(deps.logSink));

  app.get("/health", (c) => c.json({ ok: true, service: "carrier-bff" }));

  // Auth (unauthenticated entry points).
  app.route("/auth", authRoutes());

  // Authenticated control-plane.
  app.route("/me", meRoute());

  const authed = new Hono<AppEnv>();
  authed.use("*", requireAuth());
  authed.route("/orgs", orgRoutes());
  authed.route("/", projectRoutes()); // /orgs/:org/projects, /projects/*
  authed.route("/", configRoutes()); // /orgs/:org/config/*, /projects/:id/config/*
  authed.route("/", marketplaceRoutes()); // /marketplace/plugins*
  authed.route("/", pluginInstallRoutes()); // /orgs/:org/plugins*, /projects/:id/plugins*
  authed.route("/sessions", sessionRoutes());
  authed.route("/github", githubRoutes());
  app.route("/", authed);

  return app;
}
