// /sessions/:id — detail, working-copy tree/file/diff, input/interrupt, the SSE
// event relay (history replay then live), approvals, promote, archive.

import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import {
  ApprovalDecisionSchema,
  AnswerDecisionSchema,
  FileContentSchema,
  FileDiffSchema,
  SendInputSchema,
  SessionModelDefaultsSchema,
  SessionSchema,
  TreeEntrySchema,
  UsageSchema,
  type SessionEvent,
} from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { session as sessionTable } from "../db/schema.js";
import { CarrierError } from "@carrier/carrier-client";
import { orgById, resolveSession } from "./authz.js";
import { orgOwnsRepo } from "./github.js";
import { ensureCarrierSession, toSessionDto } from "./projects.js";
import { assembleSessionConfig } from "../config-assembly.js";

// Mirrors the Carrier runtime's built-in model (internal/engine/anthropic.go
// `defaultAnthropicModel`) so the composer shows a real model when none is
// configured at any scope.
const RUNTIME_DEFAULT_MODEL = "claude-opus-4-8";
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

  // ── resolved model defaults (for the composer) ──────────────────────────────
  // The EFFECTIVE model params the runtime uses by default, resolved the same way
  // session creation does (org⊕project⊕plugins). planMode is the session's own
  // persisted value. The web shows these as the real current values.
  app.get("/:id/model-params", async (c) => {
    const { db, crypto } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const cfg = await assembleSessionConfig(db, crypto, ctx.project);
    return c.json(
      SessionModelDefaultsSchema.parse({
        model: cfg.model && cfg.model.length > 0 ? cfg.model : RUNTIME_DEFAULT_MODEL,
        effort: cfg.effort ?? "",
        planMode: ctx.session.planMode,
      }),
    );
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
    const { carrier } = c.var.deps;
    const ctx = await resolveSession(c.var.deps.db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const body = SendInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    // Heal a missing Carrier session (createSession failed at create time) before
    // forwarding; if the runtime is down, 503 so the client retries.
    let cid = ctx.session.carrierSessionId;
    if (!cid) {
      cid = await ensureCarrierSession(c.var.deps, ctx.session, ctx.project);
      if (!cid) return c.json({ error: "carrier_unavailable" }, 503);
    }
    const text = body.data.text;
    const steer = body.data.steer ?? false;
    // Optional per-turn model-param overrides (absent → session defaults).
    const overrides = {
      model: body.data.model,
      effort: body.data.effort,
      planMode: body.data.planMode,
    };
    try {
      await carrier().sendInput(cid, text, steer, overrides);
    } catch (e) {
      // A stale id (Carrier restarted and forgot the session) yields 404 — heal
      // once over the same working copy and retry.
      if (e instanceof CarrierError && e.status === 404) {
        const healed = await ensureCarrierSession(c.var.deps, ctx.session, ctx.project, cid);
        if (!healed) return c.json({ error: "carrier_unavailable" }, 503);
        await carrier().sendInput(healed, text, steer, overrides);
      } else {
        throw e;
      }
    }
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

    // Heal a missing Carrier session so a (re)connecting client streams a live
    // session instead of looping on a 409. If the runtime is genuinely down, 503
    // — the EventSource retries, and "reconnecting…" now means what it says.
    let cid = ctx.session.carrierSessionId;
    if (!cid) {
      cid = await ensureCarrierSession(c.var.deps, ctx.session, ctx.project);
    }
    if (!cid) return c.json({ error: "carrier_unavailable" }, 503);

    const sessionId = ctx.session.id;
    const client = carrier();
    const initialCid = cid;
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      // End the upstream when the client disconnects.
      stream.onAbort(() => ac.abort());

      // Flush the response head immediately with an SSE comment so a
      // (re)connecting EventSource reaches `open` even though an idle session
      // emits no event for a while: Hono/the dev proxy buffer the head until the
      // first body byte, otherwise leaving the pill stuck on "connecting…". A
      // periodic comment then keeps idle connections from being reaped by
      // intermediaries (which would otherwise force a reconnect loop). Comments
      // (`:`-prefixed) are inert to EventSource, so they never reach the reducer.
      await stream.write(": connected\n\n");
      const heartbeat = setInterval(() => {
        void stream.write(": ping\n\n").catch(() => {});
      }, 15_000);
      stream.onAbort(() => clearInterval(heartbeat));

      let lastSeq = -1;

      const forward = async (raw: Parameters<typeof normalizeEvent>[0]) => {
        // Accumulate per-session usage from usage/step_finish frames (task 20).
        const delta = usageDeltaFromRaw(raw);
        if (delta) usage.add(sessionId, delta);

        const ev: SessionEvent | null = normalizeEvent(raw);
        if (!ev) return;
        // Persist auto-generated session titles BEFORE the forward-dedupe, so a
        // title is never lost if its seq trips the guard. The runtime emits it
        // once after the first turn; re-applying the same value is idempotent.
        if (ev.kind === "title" && ev.title.length > 0) {
          await db
            .update(sessionTable)
            .set({ title: ev.title })
            .where(eq(sessionTable.id, sessionId));
        }
        if (ev.seq <= lastSeq) return; // dedupe / ordering guard (forwarding)
        lastSeq = ev.seq;
        // Emit on the DEFAULT (unnamed `message`) channel — do NOT set `event:`.
        // The web subscribes via native EventSource.onmessage, which fires only
        // for unnamed events; a per-kind `event:` name would route every frame to
        // a listener the client never registers, so nothing would render. The
        // kind is already carried in the JSON payload (ev.kind) for the reducer.
        await stream.writeSSE({
          id: String(ev.seq),
          data: JSON.stringify(ev),
        });
      };

      // streamEvents yields history first (with seq) then live frames; the BFF
      // normalizes each and forwards in order, deduping by seq. A stale id (the
      // runtime restarted and forgot the session → 404) is healed once over the
      // same working copy, then the fresh Flight's stream takes over.
      let activeCid = initialCid;
      let healed = false;
      try {
        for (;;) {
          try {
            for await (const raw of client.streamEvents(activeCid, ac.signal)) {
              await forward(raw);
            }
            return; // upstream closed normally (e.g. the Flight ended)
          } catch (e) {
            if (
              !healed &&
              !ac.signal.aborted &&
              e instanceof CarrierError &&
              e.status === 404
            ) {
              healed = true;
              const fresh = await ensureCarrierSession(
                c.var.deps,
                ctx.session,
                ctx.project,
                activeCid,
              );
              if (fresh) {
                activeCid = fresh;
                continue;
              }
            }
            return; // unreachable/aborted — end the SSE response; the client reconnects.
          }
        }
      } finally {
        clearInterval(heartbeat);
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

  // ── ask_user answers ─────────────────────────────────────────────────────────
  app.post("/:id/questions/:reqId", async (c) => {
    const { db, carrier } = c.var.deps;
    const ctx = await resolveSession(db, c.var.account.id, c.req.param("id"));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const body = AnswerDecisionSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    if (!ctx.session.carrierSessionId) {
      return c.json({ error: "no_carrier_session" }, 409);
    }
    const reqId = c.req.param("reqId");
    // Deliver the user's answer to Carrier, correlated by reqId.
    await carrier().answerQuestion(
      ctx.session.carrierSessionId,
      reqId,
      body.data.answer,
    );
    return c.json({ ok: true, reqId });
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
