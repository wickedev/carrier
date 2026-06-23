// Plugin install routes (org/project scope, the lockfile). Mounted at "/" →
//   GET    /orgs/:org/plugins            /projects/:id/plugins       → PluginInstall[]
//   POST   /orgs/:org/plugins            /projects/:id/plugins       → install (201)
//   PATCH  /orgs/:org/plugins/:installId /projects/:id/plugins/:id   → enable/disable/upgrade
//   DELETE /orgs/:org/plugins/:installId /projects/:id/plugins/:id   → uninstall
//
// Authz mirrors config CRUD: GET requires membership (404 if not a member);
// mutations require a manager (owner/admin) → 403. Rows are always scoped by
// (id AND owner_id) so one scope can never touch another's install.
//
// Install records a lockfile pinning version + manifest_digest + the operator-
// approved capabilities (ungranted caps are denied at runtime). It re-verifies
// the version's detached signature (defense in depth) and enforces the org
// allowlist (if the org has any allowlist rows and the plugin isn't listed → 403).

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  InstallPluginSchema,
  PluginInstallSchema,
  PluginManifestSchema,
  type ConfigScope,
  type PluginManifest,
} from "@carrier/contract";
import type { AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import {
  orgPluginAllowlist,
  plugin,
  pluginInstall,
  pluginPublisher,
  pluginVersion,
  type PluginInstallRow,
} from "../db/schema.js";
import { verifyDetachedSignature } from "../plugin-attest.js";
import { isManager, resolveOrg, resolveProject } from "./authz.js";

type ResolvedCtx = {
  scope: ConfigScope;
  ownerId: string;
  /** The org id the install ultimately belongs to (for allowlist checks). */
  orgId: string;
  manager: boolean;
};

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function installToDto(row: PluginInstallRow) {
  return PluginInstallSchema.parse({
    id: row.id,
    scope: row.scope,
    name: row.pluginName,
    version: row.version,
    manifestDigest: row.manifestDigest,
    grantedCaps: parseJsonArray(row.grantedCapsJson),
    allowPermissions: row.allowPermissions,
    enabled: row.enabled,
  });
}

/** Resolve a published version row by plugin name + version, plus the publisher
 *  key (for signature re-verification). Null if the version doesn't exist. */
/**
 * Bound the operator-approved capabilities by what the SIGNED manifest actually
 * declares (Req 1.4 / 5.2): a granted capability the manifest never requested can
 * never be obtained. Returns null when every grant is within the manifest, or an
 * error string identifying the first over-grant. The manifest is the single
 * source of truth — never the install request.
 */
function capabilityViolation(
  grantedCaps: string[],
  allowPermissions: boolean,
  manifest: PluginManifest,
): string | null {
  const caps = manifest.capabilities;
  for (const cap of grantedCaps) {
    if (cap === "kv") {
      if (!caps.kv) return "kv";
      continue;
    }
    const secret = cap.startsWith("secret:") ? cap.slice("secret:".length) : null;
    if (secret !== null) {
      if (!caps.secrets.includes(secret)) return cap;
      continue;
    }
    const host = cap.startsWith("network:") ? cap.slice("network:".length) : null;
    if (host !== null) {
      if (!caps.network.includes(host)) return cap;
      continue;
    }
    return cap; // unknown capability token
  }
  // Granting permission-allow requires the manifest to request it.
  if (allowPermissions && !caps.permissionsAllow) return "permissions.allow";
  return null;
}

async function resolveVersion(
  db: Db,
  name: string,
  version: string,
): Promise<{
  manifestDigest: string;
  signature: string;
  publicKey: string;
  manifest: PluginManifest;
} | null> {
  const pRows = await db
    .select()
    .from(plugin)
    .where(eq(plugin.name, name))
    .limit(1);
  const p = pRows[0];
  if (!p) return null;
  const vRows = await db
    .select()
    .from(pluginVersion)
    .where(
      and(
        eq(pluginVersion.pluginId, p.id),
        eq(pluginVersion.version, version),
      ),
    )
    .limit(1);
  const v = vRows[0];
  if (!v) return null;
  const pubRows = await db
    .select()
    .from(pluginPublisher)
    .where(eq(pluginPublisher.id, p.publisherId))
    .limit(1);
  const pub = pubRows[0];
  if (!pub) return null;
  const manifest = PluginManifestSchema.safeParse(JSON.parse(v.manifestJson));
  if (!manifest.success) return null;
  return {
    manifestDigest: v.manifestDigest,
    signature: v.signature,
    publicKey: pub.publicKey,
    manifest: manifest.data,
  };
}

/** Enforce the org allowlist: if the org has any allowlist rows and the plugin
 *  isn't listed, the install is blocked. An empty allowlist allows everything. */
async function allowlisted(
  db: Db,
  orgId: string,
  pluginName: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(orgPluginAllowlist)
    .where(eq(orgPluginAllowlist.orgId, orgId));
  if (rows.length === 0) return true;
  return rows.some((r) => r.pluginName === pluginName);
}

function mountScope(
  app: Hono<AppEnv>,
  base: string, // "/orgs/:org" | "/projects/:id"
  scope: ConfigScope,
  resolve: (
    db: Db,
    accountId: string,
    param: string | undefined,
  ) => Promise<ResolvedCtx | null>,
  paramName: string,
): void {
  // LIST
  app.get(`${base}/plugins`, async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(pluginInstall)
      .where(
        and(
          eq(pluginInstall.scope, scope),
          eq(pluginInstall.ownerId, ctx.ownerId),
        ),
      );
    return c.json(rows.map(installToDto));
  });

  // INSTALL
  app.post(`${base}/plugins`, async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!ctx.manager) return c.json({ error: "forbidden" }, 403);
    const parsed = InstallPluginSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const { name, version, grantedCaps, allowPermissions } = parsed.data;

    // The pinned version must exist.
    const resolved = await resolveVersion(db, name, version);
    if (!resolved) return c.json({ error: "version_not_found" }, 400);

    // Org allowlist gate.
    if (!(await allowlisted(db, ctx.orgId, name))) {
      return c.json({ error: "not_allowlisted" }, 403);
    }

    // Defense in depth: re-verify the version's detached signature before
    // recording the install.
    if (
      !verifyDetachedSignature(
        resolved.manifestDigest,
        resolved.signature,
        resolved.publicKey,
      )
    ) {
      return c.json({ error: "bad_signature" }, 400);
    }

    // Bound the approved capabilities by the signed manifest: nothing the
    // manifest did not request can be granted.
    const over = capabilityViolation(grantedCaps, allowPermissions, resolved.manifest);
    if (over) {
      return c.json({ error: "capability_not_declared", capability: over }, 400);
    }

    const id = randomUUID();
    const row = {
      id,
      scope,
      ownerId: ctx.ownerId,
      pluginName: name,
      version,
      manifestDigest: resolved.manifestDigest, // lockfile pin
      grantedCapsJson: JSON.stringify(grantedCaps),
      allowPermissions,
      enabled: true,
    };
    await db.insert(pluginInstall).values(row);
    return c.json(installToDto(row as PluginInstallRow), 201);
  });

  // PATCH (enable/disable, or upgrade version → re-pin digest + re-verify sig)
  app.patch(`${base}/plugins/:installId`, async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!ctx.manager) return c.json({ error: "forbidden" }, 403);
    const installId = c.req.param("installId");
    const existing = await db
      .select()
      .from(pluginInstall)
      .where(
        and(
          eq(pluginInstall.id, installId),
          eq(pluginInstall.ownerId, ctx.ownerId),
        ),
      )
      .limit(1);
    const cur = existing[0];
    if (!cur) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const updates: Record<string, unknown> = {};
    if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
    if (Array.isArray(body.grantedCaps)) {
      updates.grantedCapsJson = JSON.stringify(body.grantedCaps);
    }
    if (typeof body.allowPermissions === "boolean") {
      updates.allowPermissions = body.allowPermissions;
    }

    const changingVersion =
      typeof body.version === "string" && body.version !== cur.version;
    const changingCaps =
      Array.isArray(body.grantedCaps) ||
      typeof body.allowPermissions === "boolean";

    // When the version or the granted capabilities change, re-resolve the
    // effective version's signed manifest, re-verify the signature, and bound the
    // EFFECTIVE caps (post-patch) by that manifest — so neither an upgrade nor a
    // cap edit can grant anything the manifest never requested.
    if (changingVersion || changingCaps) {
      const effectiveVersion = changingVersion
        ? (body.version as string)
        : cur.version;
      const resolved = await resolveVersion(db, cur.pluginName, effectiveVersion);
      if (!resolved) return c.json({ error: "version_not_found" }, 400);
      if (
        !verifyDetachedSignature(
          resolved.manifestDigest,
          resolved.signature,
          resolved.publicKey,
        )
      ) {
        return c.json({ error: "bad_signature" }, 400);
      }
      const effectiveCaps = Array.isArray(body.grantedCaps)
        ? (body.grantedCaps as string[])
        : parseJsonArray(cur.grantedCapsJson);
      const effectiveAllow =
        typeof body.allowPermissions === "boolean"
          ? body.allowPermissions
          : cur.allowPermissions;
      const over = capabilityViolation(
        effectiveCaps,
        effectiveAllow,
        resolved.manifest,
      );
      if (over) {
        return c.json({ error: "capability_not_declared", capability: over }, 400);
      }
      if (changingVersion) {
        updates.version = body.version;
        updates.manifestDigest = resolved.manifestDigest;
      }
    }

    if (Object.keys(updates).length > 0) {
      await db
        .update(pluginInstall)
        .set(updates)
        .where(
          and(
            eq(pluginInstall.id, installId),
            eq(pluginInstall.ownerId, ctx.ownerId),
          ),
        );
    }
    return c.json(installToDto({ ...cur, ...updates } as PluginInstallRow), 200);
  });

  // DELETE (uninstall)
  app.delete(`${base}/plugins/:installId`, async (c) => {
    const { db } = c.var.deps;
    const ctx = await resolve(db, c.var.account.id, c.req.param(paramName));
    if (!ctx) return c.json({ error: "not_found" }, 404);
    if (!ctx.manager) return c.json({ error: "forbidden" }, 403);
    await db
      .delete(pluginInstall)
      .where(
        and(
          eq(pluginInstall.id, c.req.param("installId")),
          eq(pluginInstall.ownerId, ctx.ownerId),
        ),
      );
    return c.json({ ok: true });
  });
}

export function pluginInstallRoutes(): Hono<AppEnv> {
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
        orgId: ctx.org.id,
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
        orgId: ctx.project.orgId,
        manager: isManager(ctx.role),
      };
    },
    "id",
  );

  return app;
}
