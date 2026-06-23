// Test harness: builds an in-memory app with a fake GitHub provider and a fake
// Carrier (CarrierClient driven by an injected fetchImpl). Auth is exercised via
// the real OAuth callback when a fake provider is supplied; for non-auth tests a
// signed session cookie can be minted directly.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CarrierClient, type RawCarrierEvent } from "@carrier/carrier-client";
import { createApp } from "../app.js";
import { createDeps } from "../app.js";
import { loadConfig, type Config } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { Workspace } from "../workspace/workspace.js";
import { setSession } from "../auth/session.js";
import type {
  GithubProvider,
  GithubUser,
  GithubOrgRef,
  GithubInstallationRef,
  GithubRepoRef,
  OpenPullRequestInput,
} from "../auth/github-provider.js";
import {
  account,
  membership,
  org,
  plugin,
  pluginPublisher,
  pluginVersion,
} from "../db/schema.js";
import { UsageStore } from "../usage.js";
import type { LogLine } from "../logging.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  PluginManifestSchema,
  type PluginCapabilities,
  type PluginManifest,
  type SeamKind,
  type SessionConfig,
} from "@carrier/contract";
import {
  artifactDigest,
  manifestDigest as computeManifestDigest,
  signDetached,
} from "../plugin-attest.js";

export interface FakeGithubState {
  exchange: { user: GithubUser; orgs: GithubOrgRef[] };
  installations: GithubInstallationRef[];
  reposByInstallation: Record<number, GithubRepoRef[]>;
  lastAuthorizeState?: string;
  /** Recorded getCloneInfo calls (asserts the installation-token clone path). */
  cloneInfoCalls?: Array<{ installationId: number; repoFullName: string }>;
  /** Recorded openPullRequest calls (asserts PR-on-promote). */
  pullRequests?: OpenPullRequestInput[];
}

export function makeFakeGithub(state: FakeGithubState): GithubProvider {
  state.cloneInfoCalls ??= [];
  state.pullRequests ??= [];
  return {
    getAuthorizeUrl(s) {
      state.lastAuthorizeState = s;
      return `https://github.com/login/oauth/authorize?state=${s}`;
    },
    async exchangeCode() {
      return state.exchange;
    },
    async listInstallations() {
      return state.installations;
    },
    async listInstallationRepos(id) {
      return state.reposByInstallation[id] ?? [];
    },
    async getCloneInfo(installationId, repoFullName) {
      state.cloneInfoCalls!.push({ installationId, repoFullName });
      // Mimic the real impl's tokenized clone URL shape.
      return {
        token: "fake-installation-token",
        cloneUrl: `https://x-access-token:fake-installation-token@github.com/${repoFullName}.git`,
      };
    },
    async openPullRequest(input) {
      state.pullRequests!.push(input);
      return {
        url: `https://github.com/${input.repoFullName}/pull/1`,
      };
    },
  };
}

/** A fake Carrier: canned create/input/interrupt + a scripted SSE stream. */
export class FakeCarrier {
  createdWith: Array<{ cwd?: string; planMode?: boolean }> = [];
  /** Full parsed create-session wire bodies (snake_cased), in order. */
  createBodies: Array<Record<string, unknown>> = [];
  inputs: Array<{ id: string; text: string; steer: boolean }> = [];
  interrupts: string[] = [];
  approvals: Array<{ id: string; reqId: string; allow: boolean }> = [];
  nextSessionId = "carrier-session-1";
  /** Raw events the SSE stream will emit, in order. */
  events: RawCarrierEvent[] = [];

  fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/v1/sessions") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      this.createdWith.push({ cwd: body.cwd, planMode: body.plan_mode });
      this.createBodies.push(body);
      return jsonResponse({ session_id: this.nextSessionId });
    }
    if (url.includes("/input") && method === "POST") {
      const id = url.split("/v1/sessions/")[1]!.split("/")[0]!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      this.inputs.push({ id, text: body.text, steer: !!body.steer });
      return jsonResponse({ ok: true });
    }
    if (url.includes("/interrupt") && method === "POST") {
      const id = url.split("/v1/sessions/")[1]!.split("/")[0]!;
      this.interrupts.push(id);
      return jsonResponse({ ok: true });
    }
    if (url.includes("/approvals/") && method === "POST") {
      const rest = url.split("/v1/sessions/")[1]!;
      const id = rest.split("/")[0]!;
      const reqId = rest.split("/approvals/")[1]!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      this.approvals.push({ id, reqId, allow: !!body.allow });
      return jsonResponse({ ok: true });
    }
    if (url.includes("/events")) {
      return new Response(this.sseStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  private sseStream(): ReadableStream<Uint8Array> {
    const events = this.events;
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i >= events.length) {
          controller.close();
          return;
        }
        const ev = events[i++]!;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      },
    });
  }

  client(): CarrierClient {
    return new CarrierClient({
      baseUrl: "http://carrier.test",
      token: "t",
      fetchImpl: this.fetchImpl,
    });
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  config: Config;
  workspace: Workspace;
  github: GithubProvider;
  githubState: FakeGithubState;
  carrier: FakeCarrier;
  usage: UsageStore;
  /** Captured structured log lines (task 24). */
  logLines: LogLine[];
  workspaceRoot: string;
  /** Mint a signed session cookie header for an existing account. */
  cookieFor(accountId: string): Promise<string>;
  /** Provision an account + personal org directly (bypassing OAuth). */
  seedAccount(login: string): Promise<{ accountId: string; orgId: string }>;
  addOrgMember(
    orgId: string,
    accountId: string,
    role: "owner" | "admin" | "member",
  ): Promise<void>;
  /** Seed a verified publisher with a freshly-generated ed25519 keypair. */
  seedPublisher(
    name: string,
    opts?: { verified?: boolean },
  ): Promise<{ id: string; name: string; publicKeyPem: string; privateKeyPem: string }>;
  /** Build a sample manifest + its detached signature (no DB writes). */
  buildSamplePlugin(opts: {
    name: string;
    version: string;
    publisher: string;
    privateKeyPem: string;
    declarative?: Partial<SessionConfig>;
    capabilities?: Partial<PluginCapabilities>;
    seams?: SeamKind[];
    wasmBytes?: Buffer;
  }): {
    manifest: PluginManifest;
    manifestDigest: string;
    signature: string;
    wasmBase64?: string;
  };
  /** Seed a verified publisher and directly publish a version into the DB. */
  publishSamplePlugin(opts: {
    name: string;
    version: string;
    publisher?: string;
    declarative?: Partial<SessionConfig>;
    capabilities?: Partial<PluginCapabilities>;
    seams?: SeamKind[];
    wasmBytes?: Buffer;
  }): Promise<{
    manifest: PluginManifest;
    manifestDigest: string;
    signature: string;
    publicKeyPem: string;
    privateKeyPem: string;
  }>;
}

export async function makeHarness(
  opts: {
    github?: GithubProvider;
    githubState?: FakeGithubState;
    carrier?: FakeCarrier;
  } = {},
): Promise<Harness> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "carrier-ws-"));
  const config = loadConfig({
    workspaceRoot,
    pluginArtifactsRoot: join(workspaceRoot, "plugin-artifacts"),
  });
  const db = await createDb();
  const githubState = opts.githubState ?? defaultGithubState();
  const github = opts.github ?? makeFakeGithub(githubState);
  const workspace = new Workspace(workspaceRoot, github);
  const carrier = opts.carrier ?? new FakeCarrier();
  const usage = new UsageStore();
  const logLines: LogLine[] = [];
  const deps = await createDeps({
    config,
    db,
    github,
    workspace,
    carrier: () => carrier.client(),
    usage,
    logSink: (line) => logLines.push(line),
  });
  const app = createApp(deps);

  // Standalone closures so publishSamplePlugin can reuse them without `this`.
  const seedPublisher: Harness["seedPublisher"] = async (name, pubOpts = {}) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const privateKeyPem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const id = randomUUID();
    await db.insert(pluginPublisher).values({
      id,
      name,
      publicKey: publicKeyPem,
      verified: pubOpts.verified ?? true,
    });
    return { id, name, publicKeyPem, privateKeyPem };
  };

  const buildSamplePlugin: Harness["buildSamplePlugin"] = (pOpts) => {
    const wasmBytes = pOpts.wasmBytes;
    const capabilities: PluginCapabilities = {
      network: pOpts.capabilities?.network ?? [],
      secrets: pOpts.capabilities?.secrets ?? [],
      kv: pOpts.capabilities?.kv ?? false,
      permissionsAllow: pOpts.capabilities?.permissionsAllow ?? false,
    };
    const manifest = PluginManifestSchema.parse({
      name: pOpts.name,
      version: pOpts.version,
      publisher: pOpts.publisher,
      api: "carrier.plugin/v1",
      description: `sample ${pOpts.name}`,
      seams: pOpts.seams ?? [],
      capabilities,
      ...(pOpts.declarative ? { declarative: pOpts.declarative } : {}),
      artifacts: wasmBytes
        ? { wasm: { path: "plugin.wasm", digest: artifactDigest(wasmBytes) } }
        : {},
    });
    const digest = computeManifestDigest(manifest);
    const signature = signDetached(digest, pOpts.privateKeyPem);
    return {
      manifest,
      manifestDigest: digest,
      signature,
      ...(wasmBytes ? { wasmBase64: wasmBytes.toString("base64") } : {}),
    };
  };

  return {
    app,
    db,
    config,
    workspace,
    github,
    githubState,
    carrier,
    usage,
    logLines,
    workspaceRoot,
    async cookieFor(accountId: string) {
      // Build a tiny app just to seal a cookie via setSession.
      const tmp = new Hono();
      let header = "";
      tmp.get("/", async (c) => {
        await setSession(c, config, { accountId });
        header = c.res.headers.get("set-cookie") ?? "";
        return c.text("ok");
      });
      await tmp.request("/");
      // Extract just name=value (before the first ';').
      return header.split(";")[0] ?? "";
    },
    async seedAccount(login: string) {
      const accountId = randomUUID();
      const orgId = randomUUID();
      await db.insert(account).values({
        id: accountId,
        githubUserId: `gh-${login}`,
        login,
        name: login,
        avatarUrl: `https://avatars.githubusercontent.com/${login}`,
        email: `${login}@example.com`,
      });
      await db.insert(org).values({
        id: orgId,
        kind: "personal",
        githubOrgId: null,
        slug: login,
        name: login,
        ownerAccountId: accountId,
      });
      await db
        .insert(membership)
        .values({ accountId, orgId, role: "owner" });
      return { accountId, orgId };
    },
    async addOrgMember(orgId, accountId, role) {
      await db.insert(membership).values({ accountId, orgId, role });
    },
    seedPublisher,
    buildSamplePlugin,
    async publishSamplePlugin(pOpts) {
      const publisherName = pOpts.publisher ?? `pub-${pOpts.name}`;
      const pub = await seedPublisher(publisherName, { verified: true });
      const built = buildSamplePlugin({
        name: pOpts.name,
        version: pOpts.version,
        publisher: publisherName,
        privateKeyPem: pub.privateKeyPem,
        declarative: pOpts.declarative,
        capabilities: pOpts.capabilities,
        seams: pOpts.seams,
        wasmBytes: pOpts.wasmBytes,
      });
      const pluginId = randomUUID();
      await db.insert(plugin).values({
        id: pluginId,
        name: pOpts.name,
        publisherId: pub.id,
        description: built.manifest.description,
        latestVersion: pOpts.version,
      });
      const wasm = built.manifest.artifacts.wasm;
      let artifactRef: string | null = null;
      if (wasm && pOpts.wasmBytes) {
        artifactRef = await deps.pluginArtifacts.put(
          wasm.digest,
          pOpts.wasmBytes,
        );
      }
      await db.insert(pluginVersion).values({
        id: randomUUID(),
        pluginId,
        version: pOpts.version,
        manifestDigest: built.manifestDigest,
        manifestJson: JSON.stringify(built.manifest),
        signature: built.signature,
        wasmDigest: wasm?.digest ?? null,
        artifactRef,
      });
      return {
        manifest: built.manifest,
        manifestDigest: built.manifestDigest,
        signature: built.signature,
        publicKeyPem: pub.publicKeyPem,
        privateKeyPem: pub.privateKeyPem,
      };
    },
  };
}

/** Extract `carrier_session=<value>` from a (possibly multi-cookie) Set-Cookie
 *  header, returned as a request-ready `name=value` cookie string. */
export function extractSessionCookie(setCookie: string | null): string {
  if (!setCookie) return "";
  const m = setCookie.match(/carrier_session=([^;,\s]+)/);
  return m ? `carrier_session=${m[1]}` : "";
}

export function defaultGithubState(): FakeGithubState {
  return {
    exchange: {
      user: {
        githubUserId: "gh-1",
        login: "octocat",
        name: "Octo Cat",
        avatarUrl: "https://avatars.githubusercontent.com/octocat",
        email: "octo@example.com",
      },
      orgs: [],
    },
    installations: [],
    reposByInstallation: {},
  };
}
