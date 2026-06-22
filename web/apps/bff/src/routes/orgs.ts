// /orgs — list the caller's orgs; nested project list/create live in projects.ts
// but the create route is mounted under /orgs/:org/projects there.

import { Hono } from "hono";
import { OrgSchema } from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { listOrgsForAccount } from "../auth/index.js";

export function orgRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const orgs = await listOrgsForAccount(c.var.deps.db, c.var.account.id);
    return c.json(z.array(OrgSchema).parse(orgs));
  });

  return app;
}
