import { describe, it, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, type Harness } from "./harness.js";
import { git } from "../workspace/git.js";

async function setupProject(h: Harness) {
  const a = await h.seedAccount("dev");
  const cookie = await h.cookieFor(a.accountId);
  const project = await (
    await h.app.request(`/orgs/${a.orgId}/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "App" }),
    })
  ).json();
  return { cookie, project };
}

async function newSession(h: Harness, cookie: string, projectId: string) {
  return (
    await h.app.request(`/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "S" }),
    })
  ).json();
}

describe("promote: merge working copy into base", () => {
  it("promotes session edits into the Project base", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setupProject(h);
    const s = await newSession(h, cookie, project.id);
    const cwd = h.carrier.createdWith[0]!.cwd!;
    await writeFile(join(cwd, "feature.txt"), "from session\n");

    const res = await h.app.request(`/sessions/${s.id}/promote`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(true);

    // The base now contains the promoted file.
    const basePath = h.workspace.basePath(project.id);
    expect(existsSync(join(basePath, "feature.txt"))).toBe(true);
    expect(await readFile(join(basePath, "feature.txt"), "utf8")).toBe(
      "from session\n",
    );
  });

  it("surfaces a conflict when the base advanced on the same file (409)", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setupProject(h);
    const basePath = h.workspace.basePath(project.id);

    // Session A forks, edits shared.txt.
    const sA = await newSession(h, cookie, project.id);
    const cwdA = h.carrier.createdWith[0]!.cwd!;
    await writeFile(join(cwdA, "shared.txt"), "A change\n");

    // Session B forks (also from the original base), edits the same file.
    const sB = await newSession(h, cookie, project.id);
    const cwdB = h.carrier.createdWith[1]!.cwd!;
    await writeFile(join(cwdB, "shared.txt"), "B change\n");

    // Promote A → base advances.
    const promoteA = await h.app.request(`/sessions/${sA.id}/promote`, {
      method: "POST",
      headers: { cookie },
    });
    expect(promoteA.status).toBe(200);

    // Promote B → base advanced on shared.txt since B forked → conflict.
    const promoteB = await h.app.request(`/sessions/${sB.id}/promote`, {
      method: "POST",
      headers: { cookie },
    });
    expect(promoteB.status).toBe(409);
    const body = await promoteB.json();
    expect(body.error).toBe("conflict");

    // The base is left clean (A's change intact, no merge markers).
    const baseStatus = await git(basePath, ["status", "--porcelain"]);
    expect(baseStatus.stdout.trim()).toBe("");
    expect(await readFile(join(basePath, "shared.txt"), "utf8")).toBe(
      "A change\n",
    );
  });

  it("serializes concurrent promotions per project (no base corruption)", async () => {
    const h = await makeHarness();
    const { cookie, project } = await setupProject(h);
    const basePath = h.workspace.basePath(project.id);

    // Two sessions editing DIFFERENT files (so both can merge cleanly).
    const s1 = await newSession(h, cookie, project.id);
    const cwd1 = h.carrier.createdWith[0]!.cwd!;
    await writeFile(join(cwd1, "one.txt"), "1\n");

    const s2 = await newSession(h, cookie, project.id);
    const cwd2 = h.carrier.createdWith[1]!.cwd!;
    await writeFile(join(cwd2, "two.txt"), "2\n");

    // Fire both promotions concurrently; the per-project lock serializes them.
    const [r1, r2] = await Promise.all([
      h.app.request(`/sessions/${s1.id}/promote`, {
        method: "POST",
        headers: { cookie },
      }),
      h.app.request(`/sessions/${s2.id}/promote`, {
        method: "POST",
        headers: { cookie },
      }),
    ]);
    // At least one merged; whichever forked-before-the-other may conflict, but
    // the base must never be corrupted (always clean, no merge markers).
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(
      1,
    );
    const baseStatus = await git(basePath, ["status", "--porcelain"]);
    expect(baseStatus.stdout.trim()).toBe("");
    // one.txt promoted from s1 must be present.
    expect(existsSync(join(basePath, "one.txt"))).toBe(true);
  });
});
