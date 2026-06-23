// Org- and project-scoped configuration CRUD (agents / skills / mcp / context /
// hooks / env) plus the single-row model-params upsert.
//
// Final mounted paths (this router is mounted at "/"):
//   Org:     GET|POST  /orgs/:org/config/<kind>
//            PATCH|DELETE /orgs/:org/config/<kind>/:id
//   Project: GET|POST  /projects/:id/config/<kind>
//            PATCH|DELETE /projects/:id/config/<kind>/:id
//   Model:   GET|PUT   /orgs/:org/config/model
//            GET|PUT   /projects/:id/config/model
//
// Authz: GET requires membership (resolveOrg/resolveProject → 404 if not a
// member). POST/PATCH/PUT/DELETE require a manager (owner/admin) → 403.
// Rows are always scoped by (scope, owner_id) so one scope can never touch
// another scope's row.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  AgentDefSchema,
  ContextDocSchema,
  CreateAgentDefSchema,
  CreateContextDocSchema,
  CreateEnvVarSchema,
  CreateHookDefSchema,
  CreateMcpServerSchema,
  CreateSkillDefSchema,
  EnvVarSchema,
  HookDefSchema,
  McpServerSchema,
  ModelParamsSchema,
  SkillDefSchema,
  type ConfigScope,
} from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import type { ConfigCrypto } from "../crypto.js";
import {
  configAgent,
  configContext,
  configEnv,
  configHook,
  configMcp,
  configModelParams,
  configSkill,
} from "../db/schema.js";
import { isManager, resolveOrg, resolveProject } from "./authz.js";

// A drizzle pg-table with the shared config columns. We keep the type loose
// (`any`-row) inside the descriptors and rely on the per-kind mapping functions
// for the actual field translation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigTable = any;

interface KindDescriptor {
  table: ConfigTable;
  /** Validate a create body; returns parsed value or null on failure. */
  parseCreate: (body: unknown) => unknown | null;
  /** Build the row columns (minus id/scope/owner_id/enabled) from a create body. */
  toColumns: (parsed: unknown, crypto: ConfigCrypto) => Record<string, unknown>;
  /** Map a DB row → contract DTO (scope/id come from the row). */
  toDto: (row: Record<string, unknown>) => unknown;
  /** Apply a partial PATCH body onto column updates (excluding enabled). */
  patchColumns: (
    body: Record<string, unknown>,
    crypto: ConfigCrypto,
  ) => Record<string, unknown>;
}

function jsonArray(v: unknown): string {
  return JSON.stringify(Array.isArray(v) ? v : []);
}

function parseJsonArray(s: unknown): string[] {
  if (typeof s !== "string") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function safeParse<T>(schema: z.ZodType<T>, body: unknown): T | null {
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}

const KINDS: Record<string, KindDescriptor> = {
  agents: {
    table: configAgent,
    parseCreate: (b) => safeParse(CreateAgentDefSchema, b),
    toColumns: (p) => {
      const v = p as z.infer<typeof CreateAgentDefSchema>;
      return {
        name: v.name,
        description: v.description,
        prompt: v.prompt,
        model: v.model ?? null,
      };
    },
    toDto: (r) =>
      AgentDefSchema.parse({
        id: r.id,
        scope: r.scope,
        name: r.name,
        description: r.description,
        prompt: r.prompt,
        model: (r.model as string | null) ?? undefined,
        enabled: r.enabled,
      }),
    patchColumns: (b) => {
      const out: Record<string, unknown> = {};
      if (typeof b.name === "string") out.name = b.name;
      if (typeof b.description === "string") out.description = b.description;
      if (typeof b.prompt === "string") out.prompt = b.prompt;
      if ("model" in b) out.model = b.model ?? null;
      return out;
    },
  },

  skills: {
    table: configSkill,
    parseCreate: (b) => safeParse(CreateSkillDefSchema, b),
    toColumns: (p) => {
      const v = p as z.infer<typeof CreateSkillDefSchema>;
      return {
        name: v.name,
        description: v.description,
        body: v.body,
        agent: v.agent ?? null,
        allowedTools: v.allowedTools ? jsonArray(v.allowedTools) : null,
      };
    },
    toDto: (r) =>
      SkillDefSchema.parse({
        id: r.id,
        scope: r.scope,
        name: r.name,
        description: r.description,
        body: r.body,
        agent: (r.agent as string | null) ?? undefined,
        allowedTools: r.allowedTools
          ? parseJsonArray(r.allowedTools)
          : undefined,
        enabled: r.enabled,
      }),
    patchColumns: (b) => {
      const out: Record<string, unknown> = {};
      if (typeof b.name === "string") out.name = b.name;
      if (typeof b.description === "string") out.description = b.description;
      if (typeof b.body === "string") out.body = b.body;
      if ("agent" in b) out.agent = b.agent ?? null;
      if ("allowedTools" in b) {
        out.allowedTools = b.allowedTools ? jsonArray(b.allowedTools) : null;
      }
      return out;
    },
  },

  mcp: {
    table: configMcp,
    parseCreate: (b) => safeParse(CreateMcpServerSchema, b),
    toColumns: (p) => {
      const v = p as z.infer<typeof CreateMcpServerSchema>;
      return {
        name: v.name,
        command: v.command,
        args: jsonArray(v.args),
        envKeys: jsonArray(v.envKeys),
      };
    },
    toDto: (r) =>
      McpServerSchema.parse({
        id: r.id,
        scope: r.scope,
        name: r.name,
        command: r.command,
        args: parseJsonArray(r.args),
        envKeys: parseJsonArray(r.envKeys),
        enabled: r.enabled,
      }),
    patchColumns: (b) => {
      const out: Record<string, unknown> = {};
      if (typeof b.name === "string") out.name = b.name;
      if (typeof b.command === "string") out.command = b.command;
      if ("args" in b) out.args = jsonArray(b.args);
      if ("envKeys" in b) out.envKeys = jsonArray(b.envKeys);
      return out;
    },
  },

  context: {
    table: configContext,
    parseCreate: (b) => safeParse(CreateContextDocSchema, b),
    toColumns: (p) => {
      const v = p as z.infer<typeof CreateContextDocSchema>;
      return { name: v.name, body: v.body };
    },
    toDto: (r) =>
      ContextDocSchema.parse({
        id: r.id,
        scope: r.scope,
        name: r.name,
        body: r.body,
        enabled: r.enabled,
      }),
    patchColumns: (b) => {
      const out: Record<string, unknown> = {};
      if (typeof b.name === "string") out.name = b.name;
      if (typeof b.body === "string") out.body = b.body;
      return out;
    },
  },

  hooks: {
    table: configHook,
    parseCreate: (b) => safeParse(CreateHookDefSchema, b),
    toColumns: (p) => {
      const v = p as z.infer<typeof CreateHookDefSchema>;
      return {
        name: v.name,
        event: v.event,
        command: v.command,
        matcher: v.matcher ?? null,
      };
    },
    toDto: (r) =>
      HookDefSchema.parse({
        id: r.id,
        scope: r.scope,
        name: r.name,
        event: r.event,
        command: r.command,
        matcher: (r.matcher as string | null) ?? undefined,
        enabled: r.enabled,
      }),
    patchColumns: (b) => {
      const out: Record<string, unknown> = {};
      if (typeof b.name === "string") out.name = b.name;
      if (typeof b.event === "string") out.event = b.event;
      if (typeof b.command === "string") out.command = b.command;
      if ("matcher" in b) out.matcher = b.matcher ?? null;
      return out;
    },
  },

  env: {
    table: configEnv,
    parseCreate: (b) => safeParse(CreateEnvVarSchema, b),
    toColumns: (p, crypto) => {
      const v = p as z.infer<typeof CreateEnvVarSchema>;
      return {
        key: v.key,
        valueEnc: v.secret ? crypto.encrypt(v.value) : v.value,
        secret: v.secret,
      };
    },
    // Secrets are never returned: value="" + hasValue=true. Plaintext values
    // are returned as-is.
    toDto: (r) => {
      const secret = !!r.secret;
      const stored = (r.valueEnc as string) ?? "";
      return EnvVarSchema.parse({
        id: r.id,
        scope: r.scope,
        key: r.key,
        // Secrets are write-only: never echoed back to the browser.
        value: secret ? "" : stored,
        secret,
        hasValue: stored.length > 0,
      });
    },
    // Only the key + secret flag are mapped here; value (re)encryption needs the
    // current row's secret flag, so the route handler does it (see PATCH below).
    patchColumns: (b) => {
      const out: Record<string, unknown> = {};
      if (typeof b.key === "string") out.key = b.key;
      if (typeof b.secret === "boolean") out.secret = b.secret;
      return out;
    },
  },
};

const KIND_NAMES = ["agents", "skills", "mcp", "context", "hooks", "env"] as const;

const DEFAULT_MODEL_PARAMS = {
  model: "claude-opus-4-8",
  effort: "" as const,
  maxSteps: 0,
  contextBudget: 0,
  planMode: false,
};

type ResolvedCtx = { scope: ConfigScope; ownerId: string; manager: boolean };

/** Mount all kind sub-routes + model params onto `app`, resolving the owner via
 *  `resolve` (org or project) for every request. */
function mountScope(
  app: Hono<AppEnv>,
  base: string, // e.g. "/orgs/:org" or "/projects/:id"
  scope: ConfigScope,
  resolve: (
    db: Db,
    accountId: string,
    param: string | undefined,
  ) => Promise<ResolvedCtx | null>,
  paramName: string,
): void {
  for (const kind of KIND_NAMES) {
    const desc = KINDS[kind]!;

    // LIST
    app.get(`${base}/config/${kind}`, async (c) => {
      const { db } = c.var.deps;
      const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
      if (!ctx) return c.json({ error: "not_found" }, 404);
      const rows = await db
        .select()
        .from(desc.table)
        .where(
          and(
            eq(desc.table.scope, scope),
            eq(desc.table.ownerId, ctx.ownerId),
          ),
        );
      return c.json(rows.map((r: Record<string, unknown>) => desc.toDto(r)));
    });

    // CREATE
    app.post(`${base}/config/${kind}`, async (c) => {
      const { db, crypto } = c.var.deps;
      const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
      if (!ctx) return c.json({ error: "not_found" }, 404);
      if (!ctx.manager) return c.json({ error: "forbidden" }, 403);
      const parsed = desc.parseCreate(await c.req.json().catch(() => ({})));
      if (parsed === null) return c.json({ error: "invalid_body" }, 400);
      const id = randomUUID();
      const enabled =
        typeof (parsed as { enabled?: unknown }).enabled === "boolean"
          ? (parsed as { enabled: boolean }).enabled
          : true;
      const row = {
        id,
        scope,
        ownerId: ctx.ownerId,
        enabled,
        ...desc.toColumns(parsed, crypto),
      };
      await db.insert(desc.table).values(row);
      return c.json(desc.toDto(row), 201);
    });

    // PATCH (partial, incl. enabled)
    app.patch(`${base}/config/${kind}/:cid`, async (c) => {
      const { db, crypto } = c.var.deps;
      const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
      if (!ctx) return c.json({ error: "not_found" }, 404);
      if (!ctx.manager) return c.json({ error: "forbidden" }, 403);
      const cid = c.req.param("cid");
      const existing = await db
        .select()
        .from(desc.table)
        .where(
          and(eq(desc.table.id, cid), eq(desc.table.ownerId, ctx.ownerId)),
        )
        .limit(1);
      const cur = existing[0] as Record<string, unknown> | undefined;
      if (!cur) return c.json({ error: "not_found" }, 404);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const updates: Record<string, unknown> = desc.patchColumns(body, crypto);
      if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
      // env: (re)encrypt the value when it changes, using the effective secret
      // flag (the one in the body if present, otherwise the current row's).
      if (kind === "env" && "value" in body && typeof body.value === "string") {
        const isSecret =
          typeof body.secret === "boolean" ? body.secret : !!cur.secret;
        updates.valueEnc = isSecret
          ? crypto.encrypt(body.value)
          : (body.value as string);
      }
      if (Object.keys(updates).length > 0) {
        await db
          .update(desc.table)
          .set(updates)
          .where(
            and(eq(desc.table.id, cid), eq(desc.table.ownerId, ctx.ownerId)),
          );
      }
      const merged = { ...cur, ...updates };
      return c.json(desc.toDto(merged), 200);
    });

    // DELETE
    app.delete(`${base}/config/${kind}/:cid`, async (c) => {
      const { db } = c.var.deps;
      const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
      if (!ctx) return c.json({ error: "not_found" }, 404);
      if (!ctx.manager) return c.json({ error: "forbidden" }, 403);
      await db
        .delete(desc.table)
        .where(
          and(
            eq(desc.table.id, c.req.param("cid")),
            eq(desc.table.ownerId, ctx.ownerId),
          ),
        );
      return c.json({ ok: true });
    });
  }

  // ── model params (single upsert row per scope) ────────────────────────────
  app.get(`${base}/config/model`, async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(configModelParams)
      .where(
        and(
          eq(configModelParams.scope, scope),
          eq(configModelParams.ownerId, ctx.ownerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return c.json(ModelParamsSchema.parse(DEFAULT_MODEL_PARAMS));
    return c.json(
      ModelParamsSchema.parse({
        model: row.model,
        effort: row.effort,
        maxSteps: row.maxSteps,
        contextBudget: row.contextBudget,
        planMode: row.planMode,
      }),
    );
  });

  app.put(`${base}/config/model`, async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!ctx.manager) return c.json({ error: "forbidden" }, 403);
    const body = ModelParamsSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const existing = await db
      .select()
      .from(configModelParams)
      .where(
        and(
          eq(configModelParams.scope, scope),
          eq(configModelParams.ownerId, ctx.ownerId),
        ),
      )
      .limit(1);
    const values = {
      model: body.data.model,
      effort: body.data.effort,
      maxSteps: body.data.maxSteps,
      contextBudget: body.data.contextBudget,
      planMode: body.data.planMode,
    };
    if (existing[0]) {
      await db
        .update(configModelParams)
        .set(values)
        .where(
          and(
            eq(configModelParams.scope, scope),
            eq(configModelParams.ownerId, ctx.ownerId),
          ),
        );
    } else {
      await db.insert(configModelParams).values({
        id: randomUUID(),
        scope,
        ownerId: ctx.ownerId,
        ...values,
      });
    }
    return c.json(ModelParamsSchema.parse(body.data), 200);
  });
}

export function configRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  mountScope(
    app,
    "/orgs/:org",
    "org",
    async (db, accountId, param) => {
      if (!param) return null;
      const ctx = await resolveOrg(db, accountId, param);
      if (!ctx) return null;
      return {
        scope: "org",
        ownerId: ctx.org.id,
        manager: isManager(ctx.role),
      };
    },
    "org",
  );

  mountScope(
    app,
    "/projects/:id",
    "project",
    async (db, accountId, param) => {
      if (!param) return null;
      const ctx = await resolveProject(db, accountId, param);
      if (!ctx) return null;
      return {
        scope: "project",
        ownerId: ctx.project.id,
        manager: isManager(ctx.role),
      };
    },
    "id",
  );

  return app;
}
