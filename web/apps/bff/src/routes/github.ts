// /github — list GitHub App installations + their repos, and the App install
// callback. Live GitHub App calls go through the injectable GithubProvider
// (stubbed by default; mocked in tests).
//
// SECURITY: GitHub App repo access is scoped to the caller's org. The App may be
// installed on many accounts platform-wide; an installation is only visible to —
// and bindable by — an org whose GitHub login matches the installation's account
// (`accountLogin === org.slug`). GitHub itself is the source of truth here, never
// client-supplied ids or the DB cache, so one tenant can never enumerate or clone
// another tenant's (private) repos.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { githubInstallation } from "../db/schema.js";
import type { OrgRow } from "../db/schema.js";
import type {
  GithubInstallationRef,
  GithubProvider,
} from "../auth/github-provider.js";
import { isManager, resolveOrg } from "./authz.js";

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

/**
 * The App installations that legitimately belong to an org, derived from GitHub
 * (not from client input or the DB): an installation is the org's iff its account
 * login matches the org's GitHub login. This is the single authorization gate for
 * every repo-access path (listing, binding, clone, PR).
 */
export async function orgInstallations(
  github: GithubProvider,
  org: OrgRow,
): Promise<GithubInstallationRef[]> {
  const live = await github.listInstallations();
  return live.filter((i) => i.accountLogin === org.slug);
}

export function githubRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Installations are always scoped to an org the caller is a member of.
  app.get("/orgs/:org/installations", async (c) => {
    const { db, github } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);

    const installs = await orgInstallations(github, ctx.org);
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

  // GitHub App install callback: persist the installation against an org — but
  // only after confirming (against GitHub) that the installation really belongs
  // to that org, so a caller can't graft another tenant's installation onto an
  // org they happen to manage.
  app.post("/orgs/:org/installations", async (c) => {
    const { db, github } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    const body = z
      .object({ installationId: z.number() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    const owned = await orgInstallations(github, ctx.org);
    const match = owned.find(
      (i) => i.installationId === body.data.installationId,
    );
    // The installation must exist AND be installed on this org's GitHub account.
    if (!match) return c.json({ error: "installation_not_owned" }, 403);

    const existing = await db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.orgId, ctx.org.id));
    if (!existing.some((e) => e.installationId === match.installationId)) {
      await db.insert(githubInstallation).values({
        id: randomUUID(),
        installationId: match.installationId,
        orgId: ctx.org.id,
        accountLogin: match.accountLogin,
        suspended: false,
      });
    }
    return c.json({ ok: true });
  });

  return app;
}
