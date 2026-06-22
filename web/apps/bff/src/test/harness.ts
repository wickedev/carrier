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
} from "../auth/github-provider.js";
import { account, membership, org } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

export interface FakeGithubState {
  exchange: { user: GithubUser; orgs: GithubOrgRef[] };
  installations: GithubInstallationRef[];
  reposByInstallation: Record<number, GithubRepoRef[]>;
  lastAuthorizeState?: string;
}

export function makeFakeGithub(state: FakeGithubState): GithubProvider {
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
    async getCloneInfo(_id, repoFullName) {
      return {
        token: "fake-token",
        cloneUrl: `https://github.com/${repoFullName}.git`,
      };
    },
  };
}

/** A fake Carrier: canned create/input/interrupt + a scripted SSE stream. */
export class FakeCarrier {
  createdWith: Array<{ cwd?: string; planMode?: boolean }> = [];
  inputs: Array<{ id: string; text: string; steer: boolean }> = [];
  interrupts: string[] = [];
  nextSessionId = "carrier-session-1";
  /** Raw events the SSE stream will emit, in order. */
  events: RawCarrierEvent[] = [];

  fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/v1/sessions") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      this.createdWith.push({ cwd: body.cwd, planMode: body.plan_mode });
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
  carrier: FakeCarrier;
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
}

export async function makeHarness(
  opts: {
    github?: GithubProvider;
    carrier?: FakeCarrier;
  } = {},
): Promise<Harness> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "carrier-ws-"));
  const config = loadConfig({ workspaceRoot });
  const db = await createDb();
  const github = opts.github ?? makeFakeGithub(defaultGithubState());
  const workspace = new Workspace(workspaceRoot, github);
  const carrier = opts.carrier ?? new FakeCarrier();
  const deps = await createDeps({
    config,
    db,
    github,
    workspace,
    carrier: () => carrier.client(),
  });
  const app = createApp(deps);

  return {
    app,
    db,
    config,
    workspace,
    github,
    carrier,
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
