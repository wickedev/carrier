// /orgs — list the caller's orgs; org-scoped usage rollup; member management
// (list/invite/remove, role-gated to owner/admin). Nested project list/create
// live in projects.ts (mounted under /orgs/:org/projects there).

import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { OrgSchema, RoleSchema, UsageSchema } from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { listOrgsForAccount } from "../auth/index.js";
import { isManager, resolveOrg } from "./authz.js";
import {
  account,
  membership,
  project as projectTable,
  session as sessionTable,
} from "../db/schema.js";

// Member DTO is BFF-local (not part of the shared contract).
const MemberSchema = z.object({
  accountId: z.string(),
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string(),
  role: RoleSchema,
});

const AddMemberSchema = z.object({
  login: z.string().min(1),
  role: RoleSchema,
});

export function orgRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const orgs = await listOrgsForAccount(c.var.deps.db, c.var.account.id);
    return c.json(z.array(OrgSchema).parse(orgs));
  });

  // ── usage rollup across all of the org's projects' sessions ────────────────
  app.get("/:org/usage", async (c) => {
    const { db, usage } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const projects = await db
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.orgId, ctx.org.id));
    const projectIds = projects.map((p) => p.id);
    const sessionIds = projectIds.length
      ? (
          await db
            .select({ id: sessionTable.id })
            .from(sessionTable)
            .where(inArray(sessionTable.projectId, projectIds))
        ).map((s) => s.id)
      : [];
    return c.json(UsageSchema.parse(usage.rollup(sessionIds)));
  });

  // ── members: list ──────────────────────────────────────────────────────────
  app.get("/:org/members", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select({
        accountId: account.id,
        login: account.login,
        name: account.name,
        avatarUrl: account.avatarUrl,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(account, eq(account.id, membership.accountId))
      .where(eq(membership.orgId, ctx.org.id));
    return c.json(
      z.array(MemberSchema).parse(
        rows.map((r) => ({
          accountId: r.accountId,
          login: r.login,
          name: r.name,
          avatarUrl: r.avatarUrl,
          role: r.role as z.infer<typeof RoleSchema>,
        })),
      ),
    );
  });

  // ── members: invite/add by login (owner/admin only) ────────────────────────
  app.post("/:org/members", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    const body = AddMemberSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    // Resolve the target account by GitHub login.
    const found = await db
      .select()
      .from(account)
      .where(eq(account.login, body.data.login))
      .limit(1);
    const target = found[0];
    if (!target) return c.json({ error: "account_not_found" }, 404);

    // Reconcile with the membership table: upsert the role (no duplicate rows).
    const existing = await db
      .select()
      .from(membership)
      .where(
        and(
          eq(membership.orgId, ctx.org.id),
          eq(membership.accountId, target.id),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await db
        .update(membership)
        .set({ role: body.data.role })
        .where(
          and(
            eq(membership.orgId, ctx.org.id),
            eq(membership.accountId, target.id),
          ),
        );
    } else {
      await db.insert(membership).values({
        accountId: target.id,
        orgId: ctx.org.id,
        role: body.data.role,
      });
    }

    return c.json(
      MemberSchema.parse({
        accountId: target.id,
        login: target.login,
        name: target.name,
        avatarUrl: target.avatarUrl,
        role: body.data.role,
      }),
      existing[0] ? 200 : 201,
    );
  });

  // ── members: remove (owner/admin only) ─────────────────────────────────────
  app.delete("/:org/members/:accountId", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    const targetId = c.req.param("accountId");

    // Don't allow removing the last owner (would orphan the org).
    if (targetId === ctx.org.ownerAccountId) {
      return c.json({ error: "cannot_remove_owner" }, 409);
    }

    await db
      .delete(membership)
      .where(
        and(
          eq(membership.orgId, ctx.org.id),
          eq(membership.accountId, targetId),
        ),
      );
    return c.json({ ok: true });
  });

  return app;
}
