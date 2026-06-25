import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { session as sessionTable } from "../db/schema.js";
import { makeHarness, type Harness } from "./harness.js";

async function setup(h: Harness, repoBound = false) {
  const a = await h.seedAccount("dev");
  const cookie = await h.cookieFor(a.accountId);
  const projRes = await h.app.request(`/orgs/${a.orgId}/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "App" }),
  });
  const project = await projRes.json();
  if (repoBound) {
    // The installation must be owned by this org (accountLogin === org slug
    // "dev") and grant the repo, or bind is rejected by the org-scoping gate.
    h.githubState.installations = [{ installationId: 42, accountLogin: "dev" }];
    h.githubState.reposByInstallation = {
      42: [{ fullName: "acme/app", defaultBranch: "main", private: true }],
    };
    const bindRes = await h.app.request(`/projects/${project.id}/bind`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        installationId: 42,
        repoFullName: "acme/app",
        defaultBranch: "main",
      }),
    });
    if (bindRes.status !== 200) {
      throw new Error(`bind failed: ${bindRes.status} ${await bindRes.text()}`);
    }
  }
  return { cookie, project, account: a };
}

async function createSession(h: Harness, cookie: string, projectId: string) {
  const res = await h.app.request(`/projects/${projectId}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "S" }),
  });
  return { res, body: await res.json() };
}

describe("session CRUD + Carrier brokering", () => {
  it("creating a session forks a working copy and creates a Carrier session with cwd=working copy (not the base)", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { res, body } = await createSession(h, cookie, project.id);
    expect(res.status).toBe(201);

    const created = h.carrier.createdWith[0]!;
    const base = h.workspace.basePath(project.id);
    expect(created.cwd).toBeTruthy();
    expect(created.cwd).not.toBe(base);
    expect(created.cwd).toContain(join("wc", body.id));
    expect(existsSync(created.cwd!)).toBe(true);
  });

  it("two sessions of one project get distinct working copies (isolation)", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const s1 = (await createSession(h, cookie, project.id)).body;
    const s2 = (await createSession(h, cookie, project.id)).body;
    const cwd1 = h.carrier.createdWith[0]!.cwd!;
    const cwd2 = h.carrier.createdWith[1]!.cwd!;
    expect(cwd1).not.toBe(cwd2);
    expect(s1.id).not.toBe(s2.id);

    // Editing in one working copy does not touch the other or the base.
    await writeFile(join(cwd1, "only-in-s1.txt"), "hello");
    expect(existsSync(join(cwd2, "only-in-s1.txt"))).toBe(false);
    expect(existsSync(join(h.workspace.basePath(project.id), "only-in-s1.txt"))).toBe(
      false,
    );
  });

  it("input and interrupt forward to Carrier", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);
    const inputRes = await h.app.request(`/sessions/${body.id}/input`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "do it", steer: true }),
    });
    expect(inputRes.status).toBe(200);
    expect(h.carrier.inputs[0]).toMatchObject({ text: "do it", steer: true });

    const intr = await h.app.request(`/sessions/${body.id}/interrupt`, {
      method: "POST",
      headers: { cookie },
    });
    expect(intr.status).toBe(200);
    expect(h.carrier.interrupts.length).toBe(1);
  });

  it("input heals a missing Carrier session (stillborn id) instead of 409", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);

    // Simulate a stillborn session: createSession failed at create time, so the
    // stored carrier id is null (or the runtime was restarted and forgot it).
    await h.db
      .update(sessionTable)
      .set({ carrierSessionId: null })
      .where(eq(sessionTable.id, body.id));

    h.carrier.nextSessionId = "carrier-session-healed";
    const inputRes = await h.app.request(`/sessions/${body.id}/input`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "do it" }),
    });
    expect(inputRes.status).toBe(200);
    // The message reached the freshly (re)created Carrier session…
    expect(h.carrier.inputs.at(-1)).toMatchObject({
      id: "carrier-session-healed",
      text: "do it",
    });
    // …and the healed id was persisted, so the next request reuses it.
    const rows = await h.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, body.id));
    expect(rows[0]?.carrierSessionId).toBe("carrier-session-healed");
  });

  it("events heals a missing Carrier session and streams instead of 409", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);

    await h.db
      .update(sessionTable)
      .set({ carrierSessionId: null })
      .where(eq(sessionTable.id, body.id));
    h.carrier.nextSessionId = "carrier-session-healed";
    h.carrier.events = [{ seq: 0, kind: "status", state: "running" }];

    const res = await h.app.request(`/sessions/${body.id}/events`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    await res.text(); // drain
    const rows = await h.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, body.id));
    expect(rows[0]?.carrierSessionId).toBe("carrier-session-healed");
  });

  it("tree/file read the session working copy", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);
    const cwd = h.carrier.createdWith[0]!.cwd!;
    await writeFile(join(cwd, "readme.md"), "# hi");

    const tree = await h.app.request(`/sessions/${body.id}/tree`, {
      headers: { cookie },
    });
    expect(tree.status).toBe(200);
    const entries = await tree.json();
    expect(entries.some((e: { name: string }) => e.name === "readme.md")).toBe(
      true,
    );

    const file = await h.app.request(
      `/sessions/${body.id}/file?path=readme.md`,
      { headers: { cookie } },
    );
    const fc = await file.json();
    expect(fc.content).toBe("# hi");
    expect(fc.binary).toBe(false);
  });

  it("path traversal is rejected for file/tree", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);
    const f = await h.app.request(
      `/sessions/${body.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
      { headers: { cookie } },
    );
    expect(f.status).toBe(400);
    const t = await h.app.request(
      `/sessions/${body.id}/tree?path=${encodeURIComponent("../..")}`,
      { headers: { cookie } },
    );
    expect(t.status).toBe(400);
  });

  it("diff returns before(HEAD) vs after(working tree)", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);
    const cwd = h.carrier.createdWith[0]!.cwd!;
    // Commit a base file, then modify it.
    await writeFile(join(cwd, "f.txt"), "v1\n");
    // commit through git helper indirectly: use promote path is heavy; instead
    // create the committed version by committing in the working copy directly.
    const { git } = await import("../workspace/git.js");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "base"]);
    await writeFile(join(cwd, "f.txt"), "v2\n");

    const diff = await h.app.request(`/sessions/${body.id}/diff?path=f.txt`, {
      headers: { cookie },
    });
    const d = await diff.json();
    expect(d.before).toBe("v1\n");
    expect(d.after).toBe("v2\n");
  });

  it("archiving a session prunes its working copy", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);
    const cwd = h.carrier.createdWith[0]!.cwd!;
    expect(existsSync(cwd)).toBe(true);
    const res = await h.app.request(`/sessions/${body.id}/archive`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(existsSync(cwd)).toBe(false);
  });

  it("a title_suggested event from Carrier updates the session row title in the DB", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h);
    const { body } = await createSession(h, cookie, project.id);

    // Carrier emits the auto-generated title once after the first turn.
    h.carrier.events = [
      { seq: 0, kind: "status", state: "running" },
      { seq: 1, kind: "title_suggested", title: "Add OAuth login" },
    ];

    // Drain the SSE relay so the BFF normalizes + persists the title.
    const res = await h.app.request(`/sessions/${body.id}/events`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The title event is still forwarded to the browser stream.
    expect(text).toContain("Add OAuth login");

    const rows = await h.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, body.id));
    expect(rows[0]?.title).toBe("Add OAuth login");
  });
});

describe("repo-bound sessions use worktrees", () => {
  it("forked working copy is a git worktree on carrier/<session> branch", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setup(h, true);
    const { body } = await createSession(h, cookie, project.id);
    const detail = await (
      await h.app.request(`/sessions/${body.id}`, { headers: { cookie } })
    ).json();
    expect(detail.workingCopy?.branch).toBe(`carrier/${body.id}`);
    // The worktree dir exists and is a linked checkout (.git is a file).
    const cwd = h.carrier.createdWith[0]!.cwd!;
    const dotgit = await readFile(join(cwd, ".git"), "utf8").catch(() => "");
    expect(dotgit).toContain("gitdir:");
  });
});
