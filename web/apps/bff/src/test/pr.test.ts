import { describe, it, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeHarness, defaultGithubState, type Harness } from "./harness.js";

async function setupRepoBound(h: Harness) {
  const a = await h.seedAccount("dev");
  const cookie = await h.cookieFor(a.accountId);
  const project = await (
    await h.app.request(`/orgs/${a.orgId}/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "App" }),
    })
  ).json();
  // Org "dev" owns installation 99 (accountLogin === slug) which grants acme/app.
  h.githubState.installations = [{ installationId: 99, accountLogin: "dev" }];
  h.githubState.reposByInstallation = {
    99: [{ fullName: "acme/app", defaultBranch: "main", private: true }],
  };
  const bindRes = await h.app.request(`/projects/${project.id}/bind`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      installationId: 99,
      repoFullName: "acme/app",
      defaultBranch: "main",
    }),
  });
  if (bindRes.status !== 200) {
    throw new Error(`bind failed: ${bindRes.status} ${await bindRes.text()}`);
  }
  return { cookie, project };
}

describe("promotion opens a PR for repo-bound projects (task 19)", () => {
  it("pushes the carrier/<session> branch and opens a pull request, returning the URL", async () => {
    const state = defaultGithubState();
    const h = await makeHarness({ githubState: state });
    const { cookie, project } = await setupRepoBound(h);

    const session = await (
      await h.app.request(`/projects/${project.id}/sessions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "S" }),
      })
    ).json();
    const cwd = h.carrier.createdWith[0]!.cwd!;
    await writeFile(join(cwd, "feature.txt"), "from session\n");

    const res = await h.app.request(`/sessions/${session.id}/promote`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(true);
    expect(body.pullRequestUrl).toBe("https://github.com/acme/app/pull/1");

    // A PR was opened via the installation Octokit (the provider interface).
    expect(state.pullRequests).toHaveLength(1);
    const pr = state.pullRequests![0]!;
    expect(pr).toMatchObject({
      installationId: 99,
      repoFullName: "acme/app",
      head: `carrier/${session.id}`,
      base: "main",
    });
    // A tokenized clone URL was minted for the push.
    expect(
      state.cloneInfoCalls!.some(
        (c) => c.installationId === 99 && c.repoFullName === "acme/app",
      ),
    ).toBe(true);
  });

  it("unbound projects do not open a PR", async () => {
    const state = defaultGithubState();
    const h = await makeHarness({ githubState: state });
    const a = await h.seedAccount("dev");
    const cookie = await h.cookieFor(a.accountId);
    const project = await (
      await h.app.request(`/orgs/${a.orgId}/projects`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "App" }),
      })
    ).json();
    const session = await (
      await h.app.request(`/projects/${project.id}/sessions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "S" }),
      })
    ).json();
    const cwd = h.carrier.createdWith[0]!.cwd!;
    await writeFile(join(cwd, "f.txt"), "x\n");
    const res = await h.app.request(`/sessions/${session.id}/promote`, {
      method: "POST",
      headers: { cookie },
    });
    const body = await res.json();
    expect(body.pullRequestUrl).toBeNull();
    expect(state.pullRequests).toHaveLength(0);
  });
});
