import { describe, it, expect } from "vitest";
import { makeHarness } from "./harness.js";
import { createDb } from "../db/client.js";
import { ConfigCrypto } from "../crypto.js";
import { assembleSessionConfig } from "../config-assembly.js";
import {
  configAgent,
  configContext,
  configEnv,
  configMcp,
  configModelParams,
  project as projectTable,
} from "../db/schema.js";
import { randomUUID } from "node:crypto";
import type { ProjectRow } from "../db/schema.js";

async function makeProject(
  h: Awaited<ReturnType<typeof makeHarness>>,
  orgId: string,
): Promise<ProjectRow> {
  const owner = await h.seedAccount("__creator__" + randomUUID().slice(0, 6));
  void owner;
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

describe("config CRUD + assembly (BFF)", () => {
  it("org agents: create / list / patch / delete with manager gating", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const member = await h.seedAccount("member");
    await h.addOrgMember(owner.orgId, member.accountId, "member");
    const ownerCookie = await h.cookieFor(owner.accountId);
    const memberCookie = await h.cookieFor(member.accountId);

    // member can list (membership) but cannot create (403).
    const listEmpty = await h.app.request(
      `/orgs/${owner.orgId}/config/agents`,
      { headers: { cookie: memberCookie } },
    );
    expect(listEmpty.status).toBe(200);
    expect(await listEmpty.json()).toEqual([]);

    const forbidden = await h.app.request(
      `/orgs/${owner.orgId}/config/agents`,
      {
        method: "POST",
        headers: { cookie: memberCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "a",
          description: "d",
          prompt: "p",
          enabled: true,
        }),
      },
    );
    expect(forbidden.status).toBe(403);

    // owner creates.
    const created = await h.app.request(`/orgs/${owner.orgId}/config/agents`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "reviewer",
        description: "reviews code",
        prompt: "be a reviewer",
        model: "claude-sonnet",
        enabled: true,
      }),
    });
    expect(created.status).toBe(201);
    const agent = await created.json();
    expect(agent).toMatchObject({
      scope: "org",
      name: "reviewer",
      model: "claude-sonnet",
      enabled: true,
    });
    expect(agent.id).toBeTruthy();

    // patch: toggle enabled + change prompt.
    const patched = await h.app.request(
      `/orgs/${owner.orgId}/config/agents/${agent.id}`,
      {
        method: "PATCH",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, prompt: "updated" }),
      },
    );
    expect(patched.status).toBe(200);
    const after = await patched.json();
    expect(after).toMatchObject({ enabled: false, prompt: "updated" });

    // delete.
    const del = await h.app.request(
      `/orgs/${owner.orgId}/config/agents/${agent.id}`,
      { method: "DELETE", headers: { cookie: ownerCookie } },
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const finalList = await (
      await h.app.request(`/orgs/${owner.orgId}/config/agents`, {
        headers: { cookie: ownerCookie },
      })
    ).json();
    expect(finalList).toEqual([]);
  });

  it("invalid create body → 400", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const res = await h.app.request(`/orgs/${owner.orgId}/config/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ description: "missing name" }),
    });
    expect(res.status).toBe(400);
  });

  it("project-scoped agents CRUD works and is isolated from org scope", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const proj = await makeProject(h, owner.orgId);

    // create an org-scope agent and a project-scope agent.
    await h.app.request(`/orgs/${owner.orgId}/config/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "org-agent",
        description: "d",
        prompt: "p",
        enabled: true,
      }),
    });
    const projCreate = await h.app.request(
      `/projects/${proj.id}/config/agents`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "proj-agent",
          description: "d",
          prompt: "p",
          enabled: true,
        }),
      },
    );
    expect(projCreate.status).toBe(201);
    const projAgent = await projCreate.json();
    expect(projAgent.scope).toBe("project");

    // org list shows only the org agent; project list only the project agent.
    const orgList = await (
      await h.app.request(`/orgs/${owner.orgId}/config/agents`, {
        headers: { cookie },
      })
    ).json();
    expect(orgList.map((a: { name: string }) => a.name)).toEqual(["org-agent"]);

    const projList = await (
      await h.app.request(`/projects/${proj.id}/config/agents`, {
        headers: { cookie },
      })
    ).json();
    expect(projList.map((a: { name: string }) => a.name)).toEqual([
      "proj-agent",
    ]);

    // cross-scope isolation: deleting the project agent via the org route must
    // not touch it (different owner_id).
    const crossDel = await h.app.request(
      `/orgs/${owner.orgId}/config/agents/${projAgent.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(crossDel.status).toBe(200); // delete is idempotent
    const stillThere = await (
      await h.app.request(`/projects/${proj.id}/config/agents`, {
        headers: { cookie },
      })
    ).json();
    expect(stillThere).toHaveLength(1);
  });

  it("secret env never returns its value but reports hasValue", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);

    // non-secret value is returned as-is.
    const plain = await h.app.request(`/orgs/${owner.orgId}/config/env`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "PUBLIC", value: "hello", secret: false }),
    });
    expect(plain.status).toBe(201);
    expect(await plain.json()).toMatchObject({
      key: "PUBLIC",
      value: "hello",
      secret: false,
      hasValue: true,
    });

    // secret value is write-only.
    const secret = await h.app.request(`/orgs/${owner.orgId}/config/env`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "TOKEN", value: "s3cr3t", secret: true }),
    });
    expect(secret.status).toBe(201);
    const secretDto = await secret.json();
    expect(secretDto).toMatchObject({
      key: "TOKEN",
      value: "",
      secret: true,
      hasValue: true,
    });

    const list = await (
      await h.app.request(`/orgs/${owner.orgId}/config/env`, {
        headers: { cookie },
      })
    ).json();
    const tok = list.find((e: { key: string }) => e.key === "TOKEN");
    expect(tok.value).toBe("");
    expect(tok.hasValue).toBe(true);
  });

  it("model params: defaults, upsert, and member gating", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const member = await h.seedAccount("member");
    await h.addOrgMember(owner.orgId, member.accountId, "member");
    const ownerCookie = await h.cookieFor(owner.accountId);
    const memberCookie = await h.cookieFor(member.accountId);

    // defaults when no row.
    const def = await h.app.request(`/orgs/${owner.orgId}/config/model`, {
      headers: { cookie: ownerCookie },
    });
    expect(def.status).toBe(200);
    expect(await def.json()).toEqual({
      model: "claude-opus-4-8",
      effort: "",
      maxSteps: 0,
      contextBudget: 0,
      planMode: false,
    });

    // member cannot PUT.
    const forbidden = await h.app.request(`/orgs/${owner.orgId}/config/model`, {
      method: "PUT",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        effort: "high",
        maxSteps: 5,
        contextBudget: 100,
        planMode: true,
      }),
    });
    expect(forbidden.status).toBe(403);

    // owner upserts, then GET reflects it; a second PUT updates the same row.
    const put1 = await h.app.request(`/orgs/${owner.orgId}/config/model`, {
      method: "PUT",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-x",
        effort: "high",
        maxSteps: 7,
        contextBudget: 200,
        planMode: true,
      }),
    });
    expect(put1.status).toBe(200);

    const put2 = await h.app.request(`/orgs/${owner.orgId}/config/model`, {
      method: "PUT",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-y",
        effort: "low",
        maxSteps: 1,
        contextBudget: 10,
        planMode: false,
      }),
    });
    expect(put2.status).toBe(200);

    const got = await (
      await h.app.request(`/orgs/${owner.orgId}/config/model`, {
        headers: { cookie: ownerCookie },
      })
    ).json();
    expect(got).toMatchObject({ model: "claude-y", effort: "low", maxSteps: 1 });
  });

  it("non-member cannot read config (404)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const stranger = await h.seedAccount("stranger");
    const cookie = await h.cookieFor(stranger.accountId);
    const res = await h.app.request(`/orgs/${owner.orgId}/config/agents`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("assembleSessionConfig merges org+project (project overrides) and resolves mcp env from a secret", async () => {
    // Use a standalone db + crypto so we can assert assembly directly.
    const db = await createDb();
    const crypto = new ConfigCrypto("test-secret-key");

    const orgId = randomUUID();
    const projectId = randomUUID();
    const proj: ProjectRow = {
      id: projectId,
      orgId,
      slug: "p",
      name: "p",
      archived: false,
      basePath: "/tmp/x",
      repoBound: false,
      repoFullName: null,
      repoDefaultBranch: null,
      installationId: null,
      createdAt: new Date().toISOString(),
    };

    // org-layer agent "shared" + project-layer agent "shared" (override) and
    // a project-only "proj".
    await db.insert(configAgent).values([
      {
        id: randomUUID(),
        scope: "org",
        ownerId: orgId,
        enabled: true,
        name: "shared",
        description: "org version",
        prompt: "org",
        model: null,
      },
      {
        id: randomUUID(),
        scope: "project",
        ownerId: projectId,
        enabled: true,
        name: "shared",
        description: "project version",
        prompt: "project",
        model: "claude-z",
      },
      {
        id: randomUUID(),
        scope: "org",
        ownerId: orgId,
        enabled: false, // disabled → excluded
        name: "disabled-one",
        description: "x",
        prompt: "x",
        model: null,
      },
    ]);

    // context docs: org first then project.
    await db.insert(configContext).values([
      {
        id: randomUUID(),
        scope: "org",
        ownerId: orgId,
        enabled: true,
        name: "guide",
        body: "ORG-CONTEXT",
      },
      {
        id: randomUUID(),
        scope: "project",
        ownerId: projectId,
        enabled: true,
        name: "proj-guide",
        body: "PROJECT-CONTEXT",
      },
    ]);

    // a secret env the mcp server will reference.
    await db.insert(configEnv).values([
      {
        id: randomUUID(),
        scope: "org",
        ownerId: orgId,
        enabled: true,
        key: "API_KEY",
        valueEnc: crypto.encrypt("super-secret"),
        secret: true,
      },
      {
        id: randomUUID(),
        scope: "project",
        ownerId: projectId,
        enabled: true,
        key: "PUBLIC_VAR",
        valueEnc: "plain",
        secret: false,
      },
    ]);

    await db.insert(configMcp).values({
      id: randomUUID(),
      scope: "org",
      ownerId: orgId,
      enabled: true,
      name: "fetcher",
      command: "mcp-fetch",
      args: JSON.stringify(["--flag"]),
      envKeys: JSON.stringify(["API_KEY"]),
    });

    // project model params override org.
    await db.insert(configModelParams).values([
      {
        id: randomUUID(),
        scope: "org",
        ownerId: orgId,
        model: "org-model",
        effort: "low",
        maxSteps: 3,
        contextBudget: 50,
        planMode: false,
      },
      {
        id: randomUUID(),
        scope: "project",
        ownerId: projectId,
        model: "project-model",
        effort: "high",
        maxSteps: 9,
        contextBudget: 500,
        planMode: true,
      },
    ]);

    const cfg = await assembleSessionConfig(db, crypto, proj);

    // agents: "shared" is the project override (model claude-z), disabled excluded.
    const sharedAgent = cfg.subagents?.find((a) => a.name === "shared");
    expect(sharedAgent).toMatchObject({ prompt: "project", model: "claude-z" });
    expect(cfg.subagents?.some((a) => a.name === "disabled-one")).toBe(false);

    // context concatenated org-first.
    expect(cfg.context).toBe("ORG-CONTEXT\n\nPROJECT-CONTEXT");

    // env map: secret decrypted, plaintext as-is.
    expect(cfg.env).toMatchObject({
      API_KEY: "super-secret",
      PUBLIC_VAR: "plain",
    });

    // mcp env resolved from the merged decrypted env.
    expect(cfg.mcpServers?.[0]).toMatchObject({
      name: "fetcher",
      command: "mcp-fetch",
      args: ["--flag"],
      env: { API_KEY: "super-secret" },
    });

    // model params: project wins.
    expect(cfg).toMatchObject({
      model: "project-model",
      effort: "high",
      maxSteps: 9,
      contextBudget: 500,
      planMode: true,
    });

    // project permissions attached.
    expect(cfg.permissions ?? []).toEqual([]);
  });

  it("session creation spreads the assembled config into createSession", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);

    // create a real project via the API (provisions a base workspace).
    const projRes = await h.app.request(`/orgs/${owner.orgId}/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "myproj" }),
    });
    expect(projRes.status).toBe(201);
    const proj = await projRes.json();

    // add a secret env + an mcp server that uses it at project scope.
    await h.app.request(`/projects/${proj.id}/config/env`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "TOKEN", value: "abc123", secret: true }),
    });
    await h.app.request(`/projects/${proj.id}/config/mcp`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "srv",
        command: "run",
        args: [],
        envKeys: ["TOKEN"],
        enabled: true,
      }),
    });
    // project model params with planMode true.
    await h.app.request(`/projects/${proj.id}/config/model`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-p",
        effort: "",
        maxSteps: 0,
        contextBudget: 0,
        planMode: true,
      }),
    });

    const sess = await h.app.request(`/projects/${proj.id}/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "s" }),
    });
    expect(sess.status).toBe(201);
    const sessDto = await sess.json();
    // planMode from project model-params propagates to the session.
    expect(sessDto.planMode).toBe(true);

    const body = h.carrier.createBodies.at(-1)!;
    expect(body.plan_mode).toBe(true);
    expect(body.model).toBe("claude-p");
    expect(body.env).toMatchObject({ TOKEN: "abc123" });
    expect(body.mcp_servers).toEqual([
      { name: "srv", command: "run", args: [], env: { TOKEN: "abc123" } },
    ]);
  });
});
