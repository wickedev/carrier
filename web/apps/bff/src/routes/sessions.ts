// /sessions/:id — detail, working-copy tree/file/diff, input/interrupt, the SSE
// event relay (history replay then live), approvals, promote, archive.

import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import {
  ApprovalDecisionSchema,
  FileContentSchema,
  FileDiffSchema,
  SendInputSchema,
  SessionSchema,
  TreeEntrySchema,
  UsageSchema,
  type SessionEvent,
} from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { session as sessionTable } from "../db/schema.js";
import { orgById, resolveSession } from "./authz.js";
import { orgOwnsRepo } from "./github.js";
import { toSessionDto } from "./projects.js";
import { normalizeEvent } from "../carrier.js";
import { usageDeltaFromRaw } from "../usage.js";
import {
  PathTraversalError,
  PromoteConflictError,
} from "../workspace/workspace.js";

export function sessionRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── detail ─────────────────────────────────────────────────────────────────
  app.get("/:id", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const wc = await workspace
      .workingCopyState(ctx.session.workingCopyPath, ctx.session.workingBranch)
      .catch(() => null);
    return c.json(SessionSchema.parse(await toSessionDto(ctx.session, wc)));
  });

  // ── working-copy tree / file / diff ────────────────────────────────────────
  app.get("/:id/tree", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    try {
      const entries = await workspace.tree(
        ctx.session.workingCopyPath,
        c.req.query("path") ?? "",
      );
      return c.json(z.array(TreeEntrySchema).parse(entries));
    } catch (e) {
      return pathError(c, e);
    }
  });

  app.get("/:id/file", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path_required" }, 400);
    try {
      const file = await workspace.file(ctx.session.workingCopyPath, path);
      return c.json(FileContentSchema.parse(file));
    } catch (e) {
      if (e instanceof PathTraversalError) return pathError(c, e);
      return c.json({ error: "not_found" }, 404);
    }
  });

  app.get("/:id/diff", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path_required" }, 400);
    try {
      const diff = await workspace.diff(ctx.session.workingCopyPath, path);
      return c.json(FileDiffSchema.parse(diff));
    } catch (e) {
      return pathError(c, e);
    }
  });

  // ── input / interrupt ──────────────────────────────────────────────────────
  app.post("/:id/input", async (c) => {
    const { db, carrier } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const body = SendInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    if (!ctx.session.carrierSessionId) {
      return c.json({ error: "no_carrier_session" }, 409);
    }
    await carrier().sendInput(
      ctx.session.carrierSessionId,
      body.data.text,
      body.data.steer ?? false,
    );
    return c.json({ ok: true });
  });

  app.post("/:id/interrupt", async (c) => {
    const { db, carrier } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (ctx.session.carrierSessionId) {
      await carrier().interrupt(ctx.session.carrierSessionId);
    }
    return c.json({ ok: true });
  });

  // ── SSE relay (history replay then live) ───────────────────────────────────
  app.get("/:id/events", async (c) => {
    const { db, carrier, usage } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const cid = ctx.session.carrierSessionId;
    if (!cid) return c.json({ error: "no_carrier_session" }, 409);

    const sessionId = ctx.session.id;
    const client = carrier();
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      // End the upstream when the client disconnects.
      stream.onAbort(() => ac.abort());
      let lastSeq = -1;
      try {
        // streamEvents yields history first (with seq) then live frames; the BFF
        // normalizes each and forwards in order, deduping by seq.
        for await (const raw of client.streamEvents(cid, ac.signal)) {
          // Accumulate per-session usage from usage/step_finish frames (task 20).
          const delta = usageDeltaFromRaw(raw);
          if (delta) usage.add(sessionId, delta);

          const ev: SessionEvent | null = normalizeEvent(raw);
          if (!ev) continue;
          if (ev.seq <= lastSeq) continue; // dedupe / ordering guard
          lastSeq = ev.seq;
          // Persist auto-generated session titles. The runtime emits this once
          // after the first turn; replay re-applies the same value (idempotent).
          if (ev.kind === "title" && ev.title.length > 0) {
            await db
              .update(sessionTable)
              .set({ title: ev.title })
              .where(eq(sessionTable.id, sessionId));
          }
          await stream.writeSSE({
            event: ev.kind,
            id: String(ev.seq),
            data: JSON.stringify(ev),
          });
        }
      } catch {
        // upstream closed or aborted — end the SSE response.
      }
    });
  });

  // ── usage (per-session) ────────────────────────────────────────────────────
  app.get("/:id/usage", async (c) => {
    const { db, usage } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    return c.json(UsageSchema.parse(usage.forSession(ctx.session.id)));
  });

  // ── approvals ──────────────────────────────────────────────────────────────
  app.post("/:id/approvals/:reqId", async (c) => {
    const { db, carrier } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const body = ApprovalDecisionSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    if (!ctx.session.carrierSessionId) {
      return c.json({ error: "no_carrier_session" }, 409);
    }
    const reqId = c.req.param("reqId");
    // Deliver the human approve/deny decision to Carrier, correlated by reqId.
    await carrier().resolveApproval(
      ctx.session.carrierSessionId,
      reqId,
      body.data.allow,
    );
    return c.json({ ok: true, reqId, allow: body.data.allow });
  });

  // ── promote ────────────────────────────────────────────────────────────────
  app.post("/:id/promote", async (c) => {
    const { db, workspace, github } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!ctx.session.workingBranch) {
      return c.json({ error: "no_working_branch" }, 409);
    }

    const hasBinding =
      ctx.project.repoBound &&
      !!ctx.project.repoFullName &&
      !!ctx.project.repoDefaultBranch &&
      ctx.project.installationId != null;

    // SECURITY: re-verify the stored binding at USE time against the project's
    // org. A binding created before the org-scoping gate (or whose installation/
    // repo access was since revoked) must not be usable to push/PR to another
    // tenant's repo — confirm ownership with GitHub before minting a token.
    if (hasBinding) {
      const orgRow = await orgById(db, ctx.project.orgId);
      const allowed =
        orgRow &&
        (await orgOwnsRepo(
          github,
          orgRow,
          ctx.project.installationId!,
          ctx.project.repoFullName!,
        ));
      if (!allowed) {
        return c.json({ error: "binding_not_owned" }, 403);
      }
    }

    try {
      const result = await workspace.promote({
        projectId: ctx.project.id,
        basePath: ctx.project.basePath,
        wcPath: ctx.session.workingCopyPath,
        workingBranch: ctx.session.workingBranch,
        repoBound: ctx.project.repoBound,
        message: `Promote session ${ctx.session.id}`,
        repo: hasBinding
          ? {
              installationId: ctx.project.installationId!,
              repoFullName: ctx.project.repoFullName!,
              defaultBranch: ctx.project.repoDefaultBranch!,
            }
          : undefined,
      });
      return c.json({
        ok: true,
        merged: result.merged,
        pullRequestUrl: result.pullRequestUrl,
      });
    } catch (e) {
      if (e instanceof PromoteConflictError) {
        return c.json({ error: "conflict", message: e.message }, 409);
      }
      throw e;
    }
  });

  // ── archive ────────────────────────────────────────────────────────────────
  app.post("/:id/archive", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    await db
      .update(sessionTable)
      .set({ archived: true, status: "terminated" })
      .where(eq(sessionTable.id, ctx.session.id));
    await workspace
      .removeWorkingCopy(
        ctx.project.id,
        ctx.session.id,
        ctx.session.workingCopyPath,
        ctx.project.repoBound,
      )
      .catch(() => undefined);
    return c.json({ ok: true });
  });

  return app;
}

function pathError(c: Context<AppEnv>, e: unknown) {
  if (e instanceof PathTraversalError) {
    return c.json({ error: "invalid_path" }, 400);
  }
  return c.json({ error: "not_found" }, 404);
}
