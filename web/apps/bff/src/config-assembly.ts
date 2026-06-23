// Assembles the per-session SessionConfig the BFF hands to Carrier on session
// creation: the org layer merged with the project layer (project wins on a
// name/key collision), enabled rows only, secrets decrypted, context docs
// concatenated, and the project's permission rules attached.

import { and, eq } from "drizzle-orm";
import {
  PluginManifestSchema,
  type HookEvent,
  type SessionConfig,
} from "@carrier/contract";
import type { Db } from "./db/client.js";
import type { ConfigCrypto } from "./crypto.js";
import type { ProjectRow } from "./db/schema.js";
import {
  configAgent,
  configContext,
  configEnv,
  configHook,
  configMcp,
  configModelParams,
  configSkill,
  permissionRule,
  plugin,
  pluginInstall,
  pluginVersion,
} from "./db/schema.js";
import type {
  ConfigAgentRow,
  ConfigContextRow,
  ConfigEnvRow,
  ConfigHookRow,
  ConfigMcpRow,
  ConfigModelParamsRow,
  ConfigSkillRow,
  PluginInstallRow,
} from "./db/schema.js";

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Merge two layers keyed by `keyOf`: org first, then project ADDS or OVERRIDES.
 *  Insertion order is org-then-project for non-colliding keys (used for the
 *  deterministic context-doc concatenation order). */
function mergeByKey<T>(
  orgLayer: T[],
  projectLayer: T[],
  keyOf: (row: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const row of orgLayer) byKey.set(keyOf(row), row);
  for (const row of projectLayer) byKey.set(keyOf(row), row);
  return [...byKey.values()];
}

export async function assembleSessionConfig(
  db: Db,
  crypto: ConfigCrypto,
  project: ProjectRow,
): Promise<SessionConfig> {
  const orgId = project.orgId;
  const projectId = project.id;

  // Generic enabled-only layered loader for a config table.
  async function layered<R>(table: typeof configAgent | typeof configSkill | typeof configMcp | typeof configContext | typeof configHook | typeof configEnv): Promise<{ org: R[]; project: R[] }> {
    const orgRows = (await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.scope, "org"),
          eq(table.ownerId, orgId),
          eq(table.enabled, true),
        ),
      )) as R[];
    const projectRows = (await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.scope, "project"),
          eq(table.ownerId, projectId),
          eq(table.enabled, true),
        ),
      )) as R[];
    return { org: orgRows, project: projectRows };
  }

  const agents = await layered<ConfigAgentRow>(configAgent);
  const skills = await layered<ConfigSkillRow>(configSkill);
  const mcps = await layered<ConfigMcpRow>(configMcp);
  const contexts = await layered<ConfigContextRow>(configContext);
  const hooks = await layered<ConfigHookRow>(configHook);
  const envs = await layered<ConfigEnvRow>(configEnv);

  // ── env: merged decrypted map (key collision → project wins) ──────────────
  const mergedEnvRows = mergeByKey(envs.org, envs.project, (r) => r.key);
  const envMap: Record<string, string> = {};
  for (const row of mergedEnvRows) {
    envMap[row.key] = row.secret ? crypto.decrypt(row.valueEnc) : row.valueEnc;
  }

  // ── subagents (agents) ────────────────────────────────────────────────────
  const mergedAgents = mergeByKey(agents.org, agents.project, (r) => r.name);
  const subagents = mergedAgents.map((a) => ({
    name: a.name,
    description: a.description,
    prompt: a.prompt,
    ...(a.model ? { model: a.model } : {}),
  }));

  // ── skills ────────────────────────────────────────────────────────────────
  const mergedSkills = mergeByKey(skills.org, skills.project, (r) => r.name);
  const skillSpecs = mergedSkills.map((s) => {
    const allowedTools = parseJsonArray(s.allowedTools);
    return {
      name: s.name,
      description: s.description,
      body: s.body,
      ...(s.agent ? { agent: s.agent } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
    };
  });

  // ── mcp servers (env resolved per envKey against the merged env map) ───────
  const mergedMcps = mergeByKey(mcps.org, mcps.project, (r) => r.name);
  const mcpSpecs = mergedMcps.map((m) => {
    const keys = parseJsonArray(m.envKeys);
    const serverEnv: Record<string, string> = {};
    for (const k of keys) {
      if (k in envMap) serverEnv[k] = envMap[k]!;
    }
    return {
      name: m.name,
      command: m.command,
      args: parseJsonArray(m.args),
      env: serverEnv,
    };
  });

  // ── context: concat enabled docs, org first then project (project overrides
  //    a same-named doc, org-first ordering preserved for unique names) ───────
  const contextStr = mergeByKey(contexts.org, contexts.project, (r) => r.name)
    .map((d) => d.body)
    .filter((b) => b.length > 0)
    .join("\n\n");

  // ── hooks ─────────────────────────────────────────────────────────────────
  const mergedHooks = mergeByKey(hooks.org, hooks.project, (r) => r.name);
  const hookSpecs = mergedHooks.map((h) => ({
    name: h.name,
    event: h.event as HookEvent,
    command: h.command,
    ...(h.matcher ? { matcher: h.matcher } : {}),
  }));

  // ── model params: project row → org row → defaults ────────────────────────
  const modelRows = (await db
    .select()
    .from(configModelParams)) as ConfigModelParamsRow[];
  const projectModel = modelRows.find(
    (r) => r.scope === "project" && r.ownerId === projectId,
  );
  const orgModel = modelRows.find(
    (r) => r.scope === "org" && r.ownerId === orgId,
  );
  const effectiveModel = projectModel ?? orgModel;

  // ── permissions (existing project rule rows) ──────────────────────────────
  const permRows = await db
    .select()
    .from(permissionRule)
    .where(eq(permissionRule.projectId, projectId));
  const permissions = permRows.map((p) => ({
    action: p.action,
    pattern: p.pattern,
    effect: p.effect as "allow" | "deny" | "ask",
  }));

  // ── assemble, omitting empty arrays/fields ────────────────────────────────
  const out: SessionConfig = {};
  if (contextStr.length > 0) out.context = contextStr;
  if (effectiveModel) {
    out.model = effectiveModel.model;
    if (effectiveModel.effort) out.effort = effectiveModel.effort;
    if (effectiveModel.maxSteps) out.maxSteps = effectiveModel.maxSteps;
    if (effectiveModel.contextBudget)
      out.contextBudget = effectiveModel.contextBudget;
    out.planMode = effectiveModel.planMode;
  }
  if (Object.keys(envMap).length > 0) out.env = envMap;
  if (mcpSpecs.length > 0) out.mcpServers = mcpSpecs;
  if (skillSpecs.length > 0) out.skills = skillSpecs;
  if (subagents.length > 0) out.subagents = subagents;
  if (hookSpecs.length > 0) out.hooks = hookSpecs;
  if (permissions.length > 0) out.permissions = permissions;

  // ── plugins: declarative merge + active refs ──────────────────────────────
  // Load enabled installs for the org layer (scope=org, owner=orgId) then the
  // project layer (scope=project, owner=projectId). Each plugin's declarative
  // layer is merged into the assembled config (org plugins first, project
  // plugins second); explicit per-scope config still wins on name collisions.
  // Active (WASM) plugins are appended to SessionConfig.plugins as refs.
  await mergePlugins(db, orgId, projectId, out);

  return out;
}

/** Fetch the published version row for an install by name+version, parse its
 *  manifest. Returns null if the version is missing or the manifest is invalid. */
async function manifestForInstall(
  db: Db,
  install: PluginInstallRow,
): Promise<ReturnType<typeof PluginManifestSchema.parse> | null> {
  const pRows = await db
    .select()
    .from(plugin)
    .where(eq(plugin.name, install.pluginName))
    .limit(1);
  const p = pRows[0];
  if (!p) return null;
  const vRows = await db
    .select()
    .from(pluginVersion)
    .where(
      and(
        eq(pluginVersion.pluginId, p.id),
        eq(pluginVersion.version, install.version),
      ),
    )
    .limit(1);
  const v = vRows[0];
  if (!v) return null;
  const parsed = PluginManifestSchema.safeParse(JSON.parse(v.manifestJson));
  return parsed.success ? parsed.data : null;
}

/** Append items from `incoming` that don't collide (by `keyOf`) with anything
 *  already present in `existing`. Explicit config + earlier plugins win. */
function appendNew<T>(
  existing: T[] | undefined,
  incoming: T[],
  keyOf: (row: T) => string,
): T[] {
  const seen = new Set((existing ?? []).map(keyOf));
  const out = [...(existing ?? [])];
  for (const row of incoming) {
    const k = keyOf(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

async function mergePlugins(
  db: Db,
  orgId: string,
  projectId: string,
  out: SessionConfig,
): Promise<void> {
  const orgInstalls = (await db
    .select()
    .from(pluginInstall)
    .where(
      and(
        eq(pluginInstall.scope, "org"),
        eq(pluginInstall.ownerId, orgId),
        eq(pluginInstall.enabled, true),
      ),
    )) as PluginInstallRow[];
  const projectInstalls = (await db
    .select()
    .from(pluginInstall)
    .where(
      and(
        eq(pluginInstall.scope, "project"),
        eq(pluginInstall.ownerId, projectId),
        eq(pluginInstall.enabled, true),
      ),
    )) as PluginInstallRow[];

  // Org layer first, then project layer (project plugins override org plugins
  // on collision because the org layer is applied before them).
  for (const install of [...orgInstalls, ...projectInstalls]) {
    const manifest = await manifestForInstall(db, install);
    if (!manifest) continue;

    // ── declarative merge (explicit config + earlier layers win) ────────────
    const decl = manifest.declarative;
    if (decl) {
      if (decl.context && decl.context.length > 0) {
        out.context = out.context
          ? `${out.context}\n\n${decl.context}`
          : decl.context;
      }
      if (decl.skills?.length) {
        out.skills = appendNew(out.skills, decl.skills, (s) => s.name);
      }
      if (decl.subagents?.length) {
        out.subagents = appendNew(
          out.subagents,
          decl.subagents,
          (a) => a.name,
        );
      }
      if (decl.mcpServers?.length) {
        out.mcpServers = appendNew(
          out.mcpServers,
          decl.mcpServers,
          (m) => m.name,
        );
      }
      if (decl.hooks?.length) {
        out.hooks = appendNew(
          out.hooks,
          decl.hooks,
          (h) => `${h.event}:${h.name}`,
        );
      }
      if (decl.permissions?.length) {
        // Conservative: append plugin rules after explicit ones (explicit rules
        // are consulted first by the runtime's ordered policy).
        out.permissions = [...(out.permissions ?? []), ...decl.permissions];
      }
      if (decl.env) {
        const merged: Record<string, string> = { ...decl.env, ...(out.env ?? {}) };
        out.env = merged; // explicit env wins on key collision
      }
      // model/effort/etc.: only fill when not already set explicitly.
      if (decl.model && !out.model) out.model = decl.model;
      if (decl.effort && out.effort === undefined) out.effort = decl.effort;
      if (decl.maxSteps !== undefined && out.maxSteps === undefined) {
        out.maxSteps = decl.maxSteps;
      }
      if (
        decl.contextBudget !== undefined &&
        out.contextBudget === undefined
      ) {
        out.contextBudget = decl.contextBudget;
      }
    }

    // ── active (WASM) ref ───────────────────────────────────────────────────
    const wasm = manifest.artifacts.wasm;
    if (wasm) {
      const ref = {
        name: manifest.name,
        version: install.version,
        manifestDigest: install.manifestDigest,
        wasmDigest: wasm.digest,
        grantedCaps: parseJsonArray(install.grantedCapsJson),
        allowPermissions: install.allowPermissions,
      };
      const existing = out.plugins ?? [];
      // A later layer (project) replaces an earlier same-named plugin ref.
      const filtered = existing.filter((p) => p.name !== ref.name);
      filtered.push(ref);
      out.plugins = filtered;
    }
  }
}
