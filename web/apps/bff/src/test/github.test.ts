import { describe, it, expect } from "vitest";
import { makeHarness, defaultGithubState } from "./harness.js";
import { OctokitGithubProvider } from "../auth/github-provider.js";
import { loadConfig } from "../config.js";

describe("GitHub App: installations + repos (task 9)", () => {
  it("lists installations and their accessible repos", async () => {
    const state = defaultGithubState();
    state.installations = [{ installationId: 42, accountLogin: "acme" }];
    state.reposByInstallation = {
      42: [
        { fullName: "acme/app", defaultBranch: "main", private: true },
        { fullName: "acme/web", defaultBranch: "trunk", private: false },
      ],
    };
    const h = await makeHarness({ githubState: state });
    const a = await h.seedAccount("dev");
    const cookie = await h.cookieFor(a.accountId);

    const res = await h.app.request("/github/installations", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].installationId).toBe(42);
    expect(body[0].repos.map((r: { fullName: string }) => r.fullName)).toEqual([
      "acme/app",
      "acme/web",
    ]);
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
