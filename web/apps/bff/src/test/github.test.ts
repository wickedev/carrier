import { describe, it, expect } from "vitest";
import { makeHarness, defaultGithubState } from "./harness.js";
import { OctokitGithubProvider } from "../auth/github-provider.js";
import { loadConfig } from "../config.js";

describe("GitHub App: org-scoped installations + repos (task 9)", () => {
  it("lists only installations owned by the caller's org (accountLogin === slug)", async () => {
    const state = defaultGithubState();
    // The App is installed on two accounts platform-wide; only "dev" is ours.
    state.installations = [
      { installationId: 42, accountLogin: "dev" },
      { installationId: 7, accountLogin: "acme" },
    ];
    state.reposByInstallation = {
      42: [
        { fullName: "dev/app", defaultBranch: "main", private: true },
        { fullName: "dev/web", defaultBranch: "trunk", private: false },
      ],
      7: [{ fullName: "acme/secret", defaultBranch: "main", private: true }],
    };
    const h = await makeHarness({ githubState: state });
    const a = await h.seedAccount("dev");
    const cookie = await h.cookieFor(a.accountId);

    const res = await h.app.request(`/github/orgs/${a.orgId}/installations`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].installationId).toBe(42);
    expect(body[0].repos.map((r: { fullName: string }) => r.fullName)).toEqual([
      "dev/app",
      "dev/web",
    ]);
  });

  it("does NOT expose another tenant's installation/private repos", async () => {
    const state = defaultGithubState();
    state.installations = [{ installationId: 7, accountLogin: "acme" }];
    state.reposByInstallation = {
      7: [{ fullName: "acme/secret", defaultBranch: "main", private: true }],
    };
    const h = await makeHarness({ githubState: state });
    // The caller's org is "dev"; the only installation belongs to "acme".
    const a = await h.seedAccount("dev");
    const cookie = await h.cookieFor(a.accountId);

    const res = await h.app.request(`/github/orgs/${a.orgId}/installations`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404s installations for an org the caller is not a member of", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const outsider = await h.seedAccount("outsider");
    const cookie = await h.cookieFor(outsider.accountId);
    const res = await h.app.request(
      `/github/orgs/${owner.orgId}/installations`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });
});

describe("GitHub App: installation clone token (task 9)", () => {
  it("getCloneInfo yields a tokenized x-access-token clone URL (mock provider)", async () => {
    const state = defaultGithubState();
    const h = await makeHarness({ githubState: state });
    const { cloneUrl, token } = await h.github.getCloneInfo(7, "acme/app");
    expect(token).toBeTruthy();
    expect(cloneUrl).toBe(
      `https://x-access-token:${token}@github.com/acme/app.git`,
    );
    expect(state.cloneInfoCalls).toContainEqual({
      installationId: 7,
      repoFullName: "acme/app",
    });
  });

  it("the real provider constructs without network access", () => {
    // The real App methods (listInstallations/getCloneInfo/openPullRequest) hit
    // GitHub; here we only confirm construction so the injectable interface is
    // exercised by the route/promote tests above without live calls.
    const provider = new OctokitGithubProvider(loadConfig());
    expect(provider).toBeInstanceOf(OctokitGithubProvider);
  });
});

describe("repo binding is scoped to the project's org (task 9 security)", () => {
  async function makeProject(login: string) {
    const h = await makeHarness();
    const a = await h.seedAccount(login);
    const cookie = await h.cookieFor(a.accountId);
    const project = await (
      await h.app.request(`/orgs/${a.orgId}/projects`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "App" }),
      })
    ).json();
    return { h, cookie, project, account: a };
  }

  it("rejects binding an installation the org does not own (403)", async () => {
    const { h, cookie, project } = await makeProject("dev");
    // Installation 7 belongs to "acme", not to the caller's "dev" org.
    h.githubState.installations = [{ installationId: 7, accountLogin: "acme" }];
    h.githubState.reposByInstallation = {
      7: [{ fullName: "acme/secret", defaultBranch: "main", private: true }],
    };
    const res = await h.app.request(`/projects/${project.id}/bind`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        installationId: 7,
        repoFullName: "acme/secret",
        defaultBranch: "main",
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("installation_not_owned");
  });

  it("rejects binding a repo the owned installation cannot access (403)", async () => {
    const { h, cookie, project } = await makeProject("dev");
    h.githubState.installations = [{ installationId: 42, accountLogin: "dev" }];
    h.githubState.reposByInstallation = {
      42: [{ fullName: "dev/app", defaultBranch: "main", private: false }],
    };
    const res = await h.app.request(`/projects/${project.id}/bind`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        installationId: 42,
        repoFullName: "dev/not-granted",
        defaultBranch: "main",
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("repo_not_accessible");
  });

  it("allows binding an owned installation + accessible repo (200)", async () => {
    const { h, cookie, project } = await makeProject("dev");
    h.githubState.installations = [{ installationId: 42, accountLogin: "dev" }];
    h.githubState.reposByInstallation = {
      42: [{ fullName: "dev/app", defaultBranch: "main", private: true }],
    };
    const res = await h.app.request(`/projects/${project.id}/bind`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        installationId: 42,
        repoFullName: "dev/app",
        defaultBranch: "main",
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).repo.repoFullName).toBe("dev/app");
  });
});
