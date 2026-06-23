// Marketplace registry routes (browser↔BFF only). These broker plugin discovery,
// version listing, manifest+signature download, and publish.
//
// Mounted at "/" → final paths:
//   GET  /marketplace/plugins?q=          → MarketplacePlugin[] (search)
//   GET  /marketplace/plugins/:name/versions
//   GET  /marketplace/plugins/:name/:version  → { manifest, manifestDigest, signature, wasmDigest }
//   POST /marketplace/plugins             → publish (verified publisher + detached sig)
//
// Publish verification (per the design's OCI/Sigstore-style detached attestation):
//   (a) the named publisher exists AND is `verified` (else 403 unverified_publisher),
//   (b) the detached signature verifies over the manifest digest against the
//       publisher's registered key (else 400 bad_signature),
//   (c) if the manifest references a WASM artifact, the provided bytes hash to the
//       digest the manifest recorded (else 400 wasm_digest_mismatch).
// The stored version is pinned by its immutable manifest_digest.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, eq, like, or } from "drizzle-orm";
import {
  MarketplacePluginSchema,
  PluginManifestSchema,
  PluginVersionSchema,
  type PluginManifest,
} from "@carrier/contract";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import {
  plugin,
  pluginPublisher,
  pluginVersion,
  type PluginRow,
  type PluginVersionRow,
} from "../db/schema.js";
import {
  artifactDigest,
  manifestDigest as computeManifestDigest,
  verifyDetachedSignature,
} from "../plugin-attest.js";

const PublishSchema = z.object({
  manifest: PluginManifestSchema,
  signature: z.string().min(1),
  wasmBase64: z.string().optional(),
});

/** Resolve a plugin row + its publisher by plugin name. */
async function pluginByName(
  db: Db,
  name: string,
): Promise<PluginRow | null> {
  const rows = await db
    .select()
    .from(plugin)
    .where(eq(plugin.name, name))
    .limit(1);
  return rows[0] ?? null;
}

async function versionsFor(
  db: Db,
  pluginId: string,
): Promise<PluginVersionRow[]> {
  return db
    .select()
    .from(pluginVersion)
    .where(eq(pluginVersion.pluginId, pluginId));
}

function manifestFromRow(row: PluginVersionRow): PluginManifest {
  return PluginManifestSchema.parse(JSON.parse(row.manifestJson));
}

export function marketplaceRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── search ────────────────────────────────────────────────────────────────
  app.get("/marketplace/plugins", async (c) => {
    const { db } = c.var.deps;
    const q = (c.req.query("q") ?? "").trim();
    const rows = q
      ? await db
          .select()
          .from(plugin)
          .where(
            or(
              like(plugin.name, `%${q}%`),
              like(plugin.description, `%${q}%`),
            ),
          )
      : await db.select().from(plugin);

    const listings = [];
    for (const p of rows) {
      const pub = await db
        .select()
        .from(pluginPublisher)
        .where(eq(pluginPublisher.id, p.publisherId))
        .limit(1);
      listings.push(
        MarketplacePluginSchema.parse({
          name: p.name,
          publisher: pub[0]?.name ?? "",
          verified: pub[0]?.verified ?? false,
          description: p.description,
          latestVersion: p.latestVersion ?? "",
        }),
      );
    }
    return c.json(listings);
  });

  // ── list versions ──────────────────────────────────────────────────────────
  app.get("/marketplace/plugins/:name/versions", async (c) => {
    const { db } = c.var.deps;
    const p = await pluginByName(db, c.req.param("name"));
    if (!p) return c.json({ error: "not_found" }, 404);
    const versions = await versionsFor(db, p.id);
    const out = versions.map((v) =>
      PluginVersionSchema.parse({
        name: p.name,
        version: v.version,
        manifestDigest: v.manifestDigest,
        manifest: manifestFromRow(v),
        createdAt: v.createdAt,
      }),
    );
    return c.json(out);
  });

  // ── fetch one version (manifest + detached signature + artifact refs) ──────
  app.get("/marketplace/plugins/:name/:version", async (c) => {
    const { db } = c.var.deps;
    const p = await pluginByName(db, c.req.param("name"));
    if (!p) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(pluginVersion)
      .where(
        and(
          eq(pluginVersion.pluginId, p.id),
          eq(pluginVersion.version, c.req.param("version")),
        ),
      )
      .limit(1);
    const v = rows[0];
    if (!v) return c.json({ error: "not_found" }, 404);
    return c.json({
      manifest: manifestFromRow(v),
      manifestDigest: v.manifestDigest,
      signature: v.signature,
      wasmDigest: v.wasmDigest ?? null,
    });
  });

  // ── publish ────────────────────────────────────────────────────────────────
  app.post("/marketplace/plugins", async (c) => {
    const { db, pluginArtifacts } = c.var.deps;
    const parsed = PublishSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const { manifest, signature, wasmBase64 } = parsed.data;

    // (a) publisher must exist AND be verified.
    const pubRows = await db
      .select()
      .from(pluginPublisher)
      .where(eq(pluginPublisher.name, manifest.publisher))
      .limit(1);
    const publisher = pubRows[0];
    if (!publisher || !publisher.verified) {
      return c.json({ error: "unverified_publisher" }, 403);
    }

    // (b) the detached signature must verify over the manifest digest.
    const digest = computeManifestDigest(manifest);
    if (!verifyDetachedSignature(digest, signature, publisher.publicKey)) {
      return c.json({ error: "bad_signature" }, 400);
    }

    // (c) if a WASM artifact is referenced, its bytes must hash to the recorded
    //     digest; store the bytes in the content-addressed artifact store.
    const wasmArtifact = manifest.artifacts.wasm;
    let wasmDigest: string | null = null;
    let artifactRef: string | null = null;
    if (wasmArtifact) {
      if (!wasmBase64) return c.json({ error: "wasm_digest_mismatch" }, 400);
      const bytes = Buffer.from(wasmBase64, "base64");
      if (artifactDigest(bytes) !== wasmArtifact.digest) {
        return c.json({ error: "wasm_digest_mismatch" }, 400);
      }
      wasmDigest = wasmArtifact.digest;
      artifactRef = await pluginArtifacts.put(wasmArtifact.digest, bytes);
    }

    // Upsert the plugin row (owned by this publisher).
    let p = await pluginByName(db, manifest.name);
    if (p && p.publisherId !== publisher.id) {
      // Name already owned by a different publisher.
      return c.json({ error: "name_taken" }, 403);
    }
    if (!p) {
      const id = randomUUID();
      await db.insert(plugin).values({
        id,
        name: manifest.name,
        publisherId: publisher.id,
        description: manifest.description,
        latestVersion: manifest.version,
      });
      p = (await pluginByName(db, manifest.name))!;
    }

    // Reject a duplicate (plugin_id, version).
    const existing = await db
      .select()
      .from(pluginVersion)
      .where(
        and(
          eq(pluginVersion.pluginId, p.id),
          eq(pluginVersion.version, manifest.version),
        ),
      )
      .limit(1);
    if (existing[0]) return c.json({ error: "version_exists" }, 409);

    await db.insert(pluginVersion).values({
      id: randomUUID(),
      pluginId: p.id,
      version: manifest.version,
      manifestDigest: digest,
      manifestJson: JSON.stringify(manifest),
      signature,
      wasmDigest,
      artifactRef,
    });

    // Track latest version + keep description fresh.
    await db
      .update(plugin)
      .set({ latestVersion: manifest.version, description: manifest.description })
      .where(eq(plugin.id, p.id));

    return c.json(
      {
        name: manifest.name,
        version: manifest.version,
        manifestDigest: digest,
        wasmDigest,
      },
      201,
    );
  });

  return app;
}
