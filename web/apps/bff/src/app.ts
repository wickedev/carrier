import { Hono } from "hono";

/**
 * createApp builds the BFF Hono application. The control-plane routes (auth,
 * orgs, projects, sessions, SSE relay) are mounted here; this foundation wires a
 * health check and the route group skeleton that later phases fill in.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "carrier-bff" }));

  // Route groups (filled in by later tasks):
  //   /auth/*            GitHub OAuth (SSO)
  //   /me, /orgs/*       identity + control-plane
  //   /projects/*        projects, repo binding, sessions
  //   /sessions/*        input/interrupt/events(SSE)/approvals/promote
  //   /github/*          GitHub App installations

  return app;
}
