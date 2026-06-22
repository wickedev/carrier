// createApp builds the BFF Hono application and mounts the control-plane:
// auth (GitHub OAuth + session), /me, orgs, projects (+ repo bind + sessions +
// permissions), sessions (tree/file/diff, input/interrupt, SSE relay,
// approvals, promote), and GitHub installations.

import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./context.js";
import { loadConfig, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import { OctokitGithubProvider } from "./auth/github-provider.js";
import { createCarrierClient } from "./carrier.js";
import { Workspace } from "./workspace/workspace.js";
import { authRoutes, meRoute, requireAuth } from "./auth/index.js";
import { orgRoutes } from "./routes/orgs.js";
import { projectRoutes } from "./routes/projects.js";
import { sessionRoutes } from "./routes/sessions.js";
import { githubRoutes } from "./routes/github.js";

/** Build the full set of app dependencies for production/dev startup. */
export async function createDeps(
  overrides: Partial<AppDeps> & { config?: Config } = {},
): Promise<AppDeps> {
  const config = overrides.config ?? loadConfig();
  const db = overrides.db ?? (await createDb({ dataDir: config.databaseUrl }));
  const github = overrides.github ?? new OctokitGithubProvider(config);
  const workspace =
    overrides.workspace ?? new Workspace(config.workspaceRoot, github);
  const carrier = overrides.carrier ?? (() => createCarrierClient(config));
  return { db, config, github, workspace, carrier };
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject deps onto every request.
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, service: "carrier-bff" }));

  // Auth (unauthenticated entry points).
  app.route("/auth", authRoutes());

  // Authenticated control-plane.
  app.route("/me", meRoute());

  const authed = new Hono<AppEnv>();
  authed.use("*", requireAuth());
  authed.route("/orgs", orgRoutes());
  authed.route("/", projectRoutes()); // /orgs/:org/projects, /projects/*
  authed.route("/sessions", sessionRoutes());
  authed.route("/github", githubRoutes());
  app.route("/", authed);

  return app;
}
