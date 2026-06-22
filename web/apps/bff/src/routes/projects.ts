// Project + repo-binding + session-create routes.
//   GET/POST /orgs/:org/projects        list / create (provisions base workspace)
//   GET      /projects/:id              detail
//   POST     /projects/:id/archive      archive
//   POST/DELETE /projects/:id/bind      bind / unbind repo
//   GET/POST /projects/:id/sessions     list / create (forks a working copy)
//   GET/POST/.. /projects/:id/permissions

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import {
  BindRepoSchema,
  CreateProjectSchema,
  CreateSessionSchema,
  PermissionRuleSchema,
  ProjectSchema,
  SessionSchema,
  UsageSchema,
  type Project,
  type Session,
} from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import {
  permissionRule,
  project,
  session as sessionTable,
} from "../db/schema.js";
import type { ProjectRow, SessionRow } from "../db/schema.js";
import {
  isManager,
  resolveOrg,
  resolveProject,
} from "./authz.js";
import { randomSlug } from "../workspace/workspace.js";

export function toProjectDto(p: ProjectRow): Project {
  return {
    id: p.id,
    orgId: p.orgId,
    slug: p.slug,
    name: p.name,
    archived: p.archived,
    repo:
      p.repoBound && p.repoFullName && p.repoDefaultBranch && p.installationId
        ? {
            repoFullName: p.repoFullName,
            defaultBranch: p.repoDefaultBranch,
            installationId: p.installationId,
          }
        : null,
    createdAt: p.createdAt,
  };
}

export async function toSessionDto(
  s: SessionRow,
  wc: Session["workingCopy"],
): Promise<Session> {
  return {
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    status: s.status as Session["status"],
    planMode: s.planMode,
    workingCopy: wc,
    createdAt: s.createdAt,
    archived: s.archived,
  };
}

export function projectRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── list / create under an org ───────────────────────────────────────────
  app.get("/orgs/:org/projects", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(project)
      .where(eq(project.orgId, ctx.org.id))
      .orderBy(desc(project.createdAt));
    return c.json(z.array(ProjectSchema).parse(rows.map(toProjectDto)));
  });

  app.post("/orgs/:org/projects", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveOrg(db, c.var.account.id, c.req.param("org"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role) && ctx.org.kind !== "personal") {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = CreateProjectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    const id = randomUUID();
    const slug = `${slugify(body.data.name)}-${randomSlug()}`;
    const basePath = workspace.basePath(id);
    // Provision the canonical Project base workspace (unbound → git init).
    await workspace.provisionBase({ projectId: id });
    const row: ProjectRow = {
      id,
      orgId: ctx.org.id,
      slug,
      name: body.data.name,
      archived: false,
      basePath,
      repoBound: false,
      repoFullName: null,
      repoDefaultBranch: null,
      installationId: null,
      createdAt: new Date().toISOString(),
    };
    await db.insert(project).values(row);
    return c.json(ProjectSchema.parse(toProjectDto(row)), 201);
  });

  // ── detail / archive ──────────────────────────────────────────────────────
  app.get("/projects/:id", async (c) => {
    const ctx = await resolveProject(
      c.var.deps.db,
      c.var.account.id,
      c.req.param("id"),
    );
    if (!ctx) return c.json({ error: "not_found" }, 404);
    return c.json(ProjectSchema.parse(toProjectDto(ctx.project)));
  });

  app.post("/projects/:id/archive", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    await db
      .update(project)
      .set({ archived: true })
      .where(eq(project.id, ctx.project.id));
    return c.json(
      ProjectSchema.parse(toProjectDto({ ...ctx.project, archived: true })),
    );
  });

  // ── repo bind / unbind ────────────────────────────────────────────────────
  app.post("/projects/:id/bind", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    const body = BindRepoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    const defaultBranch = body.data.defaultBranch ?? "main";
    // Re-provision the base as a clone of the bound repo.
    await workspace.provisionBase({
      projectId: ctx.project.id,
      repo: {
        installationId: body.data.installationId,
        repoFullName: body.data.repoFullName,
        defaultBranch,
      },
    });
    const updated: ProjectRow = {
      ...ctx.project,
      repoBound: true,
      repoFullName: body.data.repoFullName,
      repoDefaultBranch: defaultBranch,
      installationId: body.data.installationId,
    };
    await db
      .update(project)
      .set({
        repoBound: true,
        repoFullName: updated.repoFullName,
        repoDefaultBranch: updated.repoDefaultBranch,
        installationId: updated.installationId,
      })
      .where(eq(project.id, ctx.project.id));
    return c.json(ProjectSchema.parse(toProjectDto(updated)));
  });

  app.delete("/projects/:id/bind", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    const updated: ProjectRow = {
      ...ctx.project,
      repoBound: false,
      repoFullName: null,
      repoDefaultBranch: null,
      installationId: null,
    };
    await db
      .update(project)
      .set({
        repoBound: false,
        repoFullName: null,
        repoDefaultBranch: null,
        installationId: null,
      })
      .where(eq(project.id, ctx.project.id));
    return c.json(ProjectSchema.parse(toProjectDto(updated)));
  });

  // ── sessions: list / create ───────────────────────────────────────────────
  app.get("/projects/:id/sessions", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.projectId, ctx.project.id))
      .orderBy(desc(sessionTable.createdAt));
    const dtos: Session[] = [];
    for (const s of rows) {
      const wc = await workspace
        .workingCopyState(s.workingCopyPath, s.workingBranch)
        .catch(() => null);
      dtos.push(await toSessionDto(s, wc));
    }
    return c.json(z.array(SessionSchema).parse(dtos));
  });

  app.post("/projects/:id/sessions", async (c) => {
    const { db, workspace, carrier } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (ctx.project.archived) {
      return c.json({ error: "project_archived" }, 409);
    }
    const body = CreateSessionSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    const id = randomUUID();
    // Fork an ISOLATED working copy from the base (never the base itself).
    const fork = await workspace.fork({
      projectId: ctx.project.id,
      sessionId: id,
      basePath: ctx.project.basePath,
      repoBound: ctx.project.repoBound,
    });

    // Create the Carrier session with cwd = the per-session working copy.
    let carrierSessionId: string | null = null;
    try {
      carrierSessionId = await carrier().createSession({
        cwd: fork.workingCopyPath,
        planMode: body.data.planMode ?? false,
      });
    } catch {
      carrierSessionId = null;
    }

    const row: SessionRow = {
      id,
      projectId: ctx.project.id,
      carrierSessionId,
      title: body.data.title ?? "Untitled session",
      status: "idle",
      planMode: body.data.planMode ?? false,
      createdBy: c.var.account.id,
      archived: false,
      workingCopyPath: fork.workingCopyPath,
      workingBranch: fork.workingBranch,
      forkedFromRev: fork.forkedFromRev,
      createdAt: new Date().toISOString(),
    };
    await db.insert(sessionTable).values(row);
    const wc = await workspace
      .workingCopyState(row.workingCopyPath, row.workingBranch)
      .catch(() => null);
    return c.json(SessionSchema.parse(await toSessionDto(row, wc)), 201);
  });

  // ── usage rollup (sum across the project's sessions) ───────────────────────
  app.get("/projects/:id/usage", async (c) => {
    const { db, usage } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(eq(sessionTable.projectId, ctx.project.id));
    return c.json(UsageSchema.parse(usage.rollup(rows.map((r) => r.id))));
  });

  // ── permissions ───────────────────────────────────────────────────────────
  app.get("/projects/:id/permissions", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(permissionRule)
      .where(eq(permissionRule.projectId, ctx.project.id));
    return c.json(
      z.array(PermissionRuleSchema).parse(
        rows.map((r) => ({
          id: r.id,
          action: r.action,
          pattern: r.pattern,
          effect: r.effect as "allow" | "deny" | "ask",
        })),
      ),
    );
  });

  app.post("/projects/:id/permissions", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    const Input = PermissionRuleSchema.omit({ id: true });
    const body = Input.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const id = randomUUID();
    await db.insert(permissionRule).values({
      id,
      projectId: ctx.project.id,
      action: body.data.action,
      pattern: body.data.pattern,
      effect: body.data.effect,
      source: "user",
    });
    return c.json(PermissionRuleSchema.parse({ id, ...body.data }), 201);
  });

  app.delete("/projects/:id/permissions/:ruleId", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    await db
      .delete(permissionRule)
      .where(
        and(
          eq(permissionRule.id, c.req.param("ruleId")),
          eq(permissionRule.projectId, ctx.project.id),
        ),
      );
    return c.json({ ok: true });
  });

  return app;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "project"
  );
}
