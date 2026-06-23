import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeHarness } from "./harness.js";
import { ConfigCrypto } from "../crypto.js";
import { assembleSessionConfig } from "../config-assembly.js";
import { pluginInstall, project as projectTable } from "../db/schema.js";
import type { ProjectRow } from "../db/schema.js";

async function makeProject(
  h: Awaited<ReturnType<typeof makeHarness>>,
  orgId: string,
): Promise<ProjectRow> {
  const id = randomUUID();
  const row: ProjectRow = {
    id,
    orgId,
    slug: `p-${id.slice(0, 6)}`,
    name: "proj",
    archived: false,
    basePath: "/tmp/none",
    repoBound: false,
    repoFullName: null,
    repoDefaultBranch: null,
    installationId: null,
    createdAt: new Date().toISOString(),
  };
  await h.db.insert(projectTable).values(row);
  return row;
}

async function installRow(
  h: Awaited<ReturnType<typeof makeHarness>>,
  opts: {
    scope: "org" | "project";
    ownerId: string;
    name: string;
    version: string;
    manifestDigest: string;
    grantedCaps?: string[];
    allowPermissions?: boolean;
    enabled?: boolean;
  },
): Promise<void> {
  await h.db.insert(pluginInstall).values({
    id: randomUUID(),
    scope: opts.scope,
    ownerId: opts.ownerId,
    pluginName: opts.name,
    version: opts.version,
    manifestDigest: opts.manifestDigest,
    grantedCapsJson: JSON.stringify(opts.grantedCaps ?? []),
    allowPermissions: opts.allowPermissions ?? false,
    enabled: opts.enabled ?? true,
  });
}

const crypto = new ConfigCrypto("test-secret-key-32-chars-long!!!");

describe("config-assembly plugin integration", () => {
  it("merges a declarative plugin's skill into the assembled config", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const proj = await makeProject(h, owner.orgId);

    const pub = await h.publishSamplePlugin({
      name: "acme/skills",
      version: "1.0.0",
      declarative: {
        skills: [
          { name: "review", description: "review code", body: "do review" },
        ],
        context: "PLUGIN CONTEXT",
      },
    });

    await installRow(h, {
      scope: "org",
      ownerId: owner.orgId,
      name: "acme/skills",
      version: "1.0.0",
      manifestDigest: pub.manifestDigest,
    });

    const cfg = await assembleSessionConfig(h.db, crypto, proj);
    expect(cfg.skills?.map((s) => s.name)).toContain("review");
    expect(cfg.context).toContain("PLUGIN CONTEXT");
  });

  it("forwards an active plugin's ref with wasm_digest + granted caps", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const proj = await makeProject(h, owner.orgId);

    const wasmBytes = Buffer.from("wasm-bytes");
    const pub = await h.publishSamplePlugin({
      name: "acme/active",
      version: "1.0.0",
      wasmBytes,
      seams: ["tool_before"],
    });

    await installRow(h, {
      scope: "org",
      ownerId: owner.orgId,
      name: "acme/active",
      version: "1.0.0",
      manifestDigest: pub.manifestDigest,
      grantedCaps: ["kv"],
      allowPermissions: true,
    });

    const cfg = await assembleSessionConfig(h.db, crypto, proj);
    expect(cfg.plugins).toHaveLength(1);
    expect(cfg.plugins![0]).toMatchObject({
      name: "acme/active",
      version: "1.0.0",
      manifestDigest: pub.manifestDigest,
      wasmDigest: pub.manifest.artifacts.wasm!.digest,
      grantedCaps: ["kv"],
      allowPermissions: true,
    });
  });

  it("disabled installs are ignored", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const proj = await makeProject(h, owner.orgId);
    const pub = await h.publishSamplePlugin({
      name: "acme/active",
      version: "1.0.0",
      wasmBytes: Buffer.from("w"),
    });
    await installRow(h, {
      scope: "org",
      ownerId: owner.orgId,
      name: "acme/active",
      version: "1.0.0",
      manifestDigest: pub.manifestDigest,
      enabled: false,
    });
    const cfg = await assembleSessionConfig(h.db, crypto, proj);
    expect(cfg.plugins).toBeUndefined();
  });

  it("project plugin overrides an org plugin's active ref", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const proj = await makeProject(h, owner.orgId);

    // Same plugin name, two versions; org installs v1, project installs v2.
    const v1 = await h.publishSamplePlugin({
      name: "acme/active",
      version: "1.0.0",
      publisher: "acme",
      wasmBytes: Buffer.from("v1-bytes"),
    });
    // Publish v2 under the same plugin row (reuse publisher key).
    const { plugin, pluginVersion } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const pRows = await h.db
      .select()
      .from(plugin)
      .where(eq(plugin.name, "acme/active"))
      .limit(1);
    const built2 = h.buildSamplePlugin({
      name: "acme/active",
      version: "2.0.0",
      publisher: "acme",
      privateKeyPem: v1.privateKeyPem,
      wasmBytes: Buffer.from("v2-bytes"),
    });
    await h.db.insert(pluginVersion).values({
      id: randomUUID(),
      pluginId: pRows[0]!.id,
      version: "2.0.0",
      manifestDigest: built2.manifestDigest,
      manifestJson: JSON.stringify(built2.manifest),
      signature: built2.signature,
      wasmDigest: built2.manifest.artifacts.wasm!.digest,
      artifactRef: null,
    });

    await installRow(h, {
      scope: "org",
      ownerId: owner.orgId,
      name: "acme/active",
      version: "1.0.0",
      manifestDigest: v1.manifestDigest,
    });
    await installRow(h, {
      scope: "project",
      ownerId: proj.id,
      name: "acme/active",
      version: "2.0.0",
      manifestDigest: built2.manifestDigest,
    });

    const cfg = await assembleSessionConfig(h.db, crypto, proj);
    expect(cfg.plugins).toHaveLength(1);
    expect(cfg.plugins![0]!.version).toBe("2.0.0");
    expect(cfg.plugins![0]!.manifestDigest).toBe(built2.manifestDigest);
  });

  it("explicit config wins over a plugin's declarative skill of the same name", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const proj = await makeProject(h, owner.orgId);

    // Explicit project skill named "review".
    const { configSkill } = await import("../db/schema.js");
    await h.db.insert(configSkill).values({
      id: randomUUID(),
      scope: "project",
      ownerId: proj.id,
      enabled: true,
      name: "review",
      description: "EXPLICIT",
      body: "explicit body",
      agent: null,
      allowedTools: null,
    });

    const pub = await h.publishSamplePlugin({
      name: "acme/skills",
      version: "1.0.0",
      declarative: {
        skills: [
          { name: "review", description: "PLUGIN", body: "plugin body" },
        ],
      },
    });
    await installRow(h, {
      scope: "org",
      ownerId: owner.orgId,
      name: "acme/skills",
      version: "1.0.0",
      manifestDigest: pub.manifestDigest,
    });

    const cfg = await assembleSessionConfig(h.db, crypto, proj);
    const review = cfg.skills?.filter((s) => s.name === "review") ?? [];
    expect(review).toHaveLength(1);
    expect(review[0]!.description).toBe("EXPLICIT");
  });
});
