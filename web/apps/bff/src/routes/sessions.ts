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
  type SessionEvent,
} from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { session as sessionTable } from "../db/schema.js";
import { resolveSession } from "./authz.js";
import { toSessionDto } from "./projects.js";
import { normalizeEvent } from "../carrier.js";
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
    const { db, carrier } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const cid = ctx.session.carrierSessionId;
    if (!cid) return c.json({ error: "no_carrier_session" }, 409);

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
          const ev: SessionEvent | null = normalizeEvent(raw);
          if (!ev) continue;
          if (ev.seq <= lastSeq) continue; // dedupe / ordering guard
          lastSeq = ev.seq;
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

  // ── approvals ──────────────────────────────────────────────────────────────
  app.post("/:id/approvals/:reqId", async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const body = ApprovalDecisionSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    // Carrier's approval control channel is delivered out-of-band; recorded and
    // acknowledged here (Carrier decision-delivery endpoint is stubbed).
    return c.json({ ok: true, reqId: c.req.param("reqId"), allow: body.data.allow });
  });

  // ── promote ────────────────────────────────────────────────────────────────
  app.post("/:id/promote", async (c) => {
    const { db, workspace } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!ctx.session.workingBranch) {
      return c.json({ error: "no_working_branch" }, 409);
    }
    try {
      const result = await workspace.promote({
        projectId: ctx.project.id,
        basePath: ctx.project.basePath,
        wcPath: ctx.session.workingCopyPath,
        workingBranch: ctx.session.workingBranch,
        repoBound: ctx.project.repoBound,
        message: `Promote session ${ctx.session.id}`,
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
