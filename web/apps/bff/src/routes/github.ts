// /github — list GitHub App installations + their repos, and the App install
// callback. Live GitHub App calls go through the injectable GithubProvider
// (stubbed by default; mocked in tests). Installations are also recorded in the
// DB so projects can bind by installation id.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { githubInstallation } from "../db/schema.js";
import { resolveOrg } from "./authz.js";

const InstallationDtoSchema = z.object({
  installationId: z.number(),
  accountLogin: z.string(),
  repos: z.array(
    z.object({
      fullName: z.string(),
      defaultBranch: z.string(),
      private: z.boolean(),
    }),
  ),
});

export function githubRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/installations", async (c) => {
    const { github } = c.var.deps;
    const installs = await github.listInstallations();
    const out = [];
    for (const inst of installs) {
      const repos = await github.listInstallationRepos(inst.installationId);
      out.push({
        installationId: inst.installationId,
        accountLogin: inst.accountLogin,
        repos: repos.map((r) => ({
          fullName: r.fullName,
          defaultBranch: r.defaultBranch,
          private: r.private,
        })),
      });
    }
    return c.json(z.array(InstallationDtoSchema).parse(out));
  });

  // GitHub App install callback: persist the installation against an org.
  app.post("/app/callback", async (c) => {
    const { db } = c.var.deps;
    const body = z
      .object({ installationId: z.number(), org: z.string() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const ctx = await resolveOrg(db, c.var.account.id, body.data.org);
    if (!ctx) return c.json({ error: "not_found" }, 404);

    const existing = await db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.orgId, ctx.org.id));
    if (!existing.some((e) => e.installationId === body.data.installationId)) {
      await db.insert(githubInstallation).values({
        id: randomUUID(),
        installationId: body.data.installationId,
        orgId: ctx.org.id,
        accountLogin: ctx.org.slug,
        suspended: false,
      });
    }
    return c.json({ ok: true });
  });

  return app;
}
