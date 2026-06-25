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
import type { AppDeps, AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import {
  permissionRule,
  project,
  session as sessionTable,
} from "../db/schema.js";
import type { ProjectRow, SessionRow } from "../db/schema.js";
import {
  isManager,
  orgById,
  resolveOrg,
  resolveProject,
} from "./authz.js";
import { orgInstallations } from "./github.js";
import { randomSlug } from "../workspace/workspace.js";
import { assembleSessionConfig } from "../config-assembly.js";

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

// ── carrier session healing ──────────────────────────────────────────────────
//
// The Carrier runtime keeps its session registry (owners/hubs/Flights) in memory
// only — it is the volatile execution tier. The BFF (durable PGlite) is the
// control plane and owns the session config. So a Carrier session id can go dead
// two ways: it was never created (createSession failed at session-create time, so
// we stored null) or it is stale (the runtime restarted and forgot it → 404). In
// both cases the BFF can re-create a Flight over the SAME working copy and persist
// the new id, which is what `ensureCarrierSession` does. Without this, a dead id
// makes /events relay nothing and /input 409 forever, which the browser surfaces
// as a permanent "reconnecting…".

/** Coalesces concurrent (re)creations per session into one createSession so a
 *  racing /events + /input never spawn two Flights. The BFF is one process, so a
 *  module Map is sufficient. */
const ensuringCarrier = new Map<string, Promise<string | null>>();

async function currentCarrierId(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db
    .select({ cid: sessionTable.carrierSessionId })
    .from(sessionTable)
    .where(eq(sessionTable.id, sessionId))
    .limit(1);
  return rows[0]?.cid ?? null;
}

/**
 * Ensure the session has a LIVE Carrier session id, (re)creating a Flight over the
 * session's existing working copy when the stored id is missing or stale, and
 * persisting the fresh id. Returns null only when the Carrier runtime is genuinely
 * unreachable — a transient condition the caller surfaces as 503 so the client
 * keeps retrying (which is now honest: it only "reconnects" while Carrier is down).
 *
 * @param staleId the id the caller just saw rejected with 404; pass it so a value
 *   already healed by a concurrent request is reused instead of spawning a Flight.
 */
export async function ensureCarrierSession(
  deps: AppDeps,
  session: SessionRow,
  project: ProjectRow,
  staleId: string | null = null,
): Promise<string | null> {
  const { db } = deps;
  const current = await currentCarrierId(db, session.id);
  if (current && current !== staleId) return current;

  const inflight = ensuringCarrier.get(session.id);
  if (inflight) return inflight;

  const p = (async (): Promise<string | null> => {
    // Re-read under the single-flight: a racer may have healed already.
    const again = await currentCarrierId(db, session.id);
    if (again && again !== staleId) return again;

    const cfg = await assembleSessionConfig(db, deps.crypto, project);
    const planMode = (cfg.planMode ?? false) || session.planMode;
    let cid: string | null = null;
    try {
      cid = await deps.carrier().createSession({
        cwd: session.workingCopyPath,
        ...cfg,
        planMode,
      });
    } catch {
      cid = null; // Carrier unreachable — caller retries.
    }
    if (cid) {
      await db
        .update(sessionTable)
        .set({ carrierSessionId: cid })
        .where(eq(sessionTable.id, session.id));
    }
    return cid;
  })();
  ensuringCarrier.set(session.id, p);
  try {
    return await p;
  } finally {
    ensuringCarrier.delete(session.id);
  }
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
    const { db, workspace, github } = c.var.deps;
    const ctx = await resolveProject(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!isManager(ctx.role)) return c.json({ error: "forbidden" }, 403);
    const body = BindRepoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    // SECURITY: the installation + repo must belong to THIS project's org —
    // confirmed against GitHub, not trusted from the request — so a project can't
    // be bound to another tenant's installation to clone its private repos.
    const orgRow = await orgById(db, ctx.project.orgId);
    if (!orgRow) return c.json({ error: "not_found" }, 404);
    const owned = await orgInstallations(github, orgRow);
    const inst = owned.find(
      (i) => i.installationId === body.data.installationId,
    );
    if (!inst) return c.json({ error: "installation_not_owned" }, 403);
    const repos = await github.listInstallationRepos(inst.installationId);
    if (!repos.some((r) => r.fullName === body.data.repoFullName)) {
      return c.json({ error: "repo_not_accessible" }, 403);
    }

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
    const { db, workspace, carrier, crypto } = c.var.deps;
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

    // Assemble the effective per-session config (org⊕project, secrets resolved).
    const sessionConfig = await assembleSessionConfig(db, crypto, ctx.project);
    // planMode is the project model-params planMode OR the request body planMode.
    const planMode = (sessionConfig.planMode ?? false) || (body.data.planMode ?? false);

    // Create the Carrier session with cwd = the per-session working copy.
    let carrierSessionId: string | null = null;
    try {
      carrierSessionId = await carrier().createSession({
        cwd: fork.workingCopyPath,
        ...sessionConfig,
        planMode,
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
      planMode,
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
