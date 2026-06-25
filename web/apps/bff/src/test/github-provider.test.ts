import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import {
  isGithubAppConfigured,
  StubGithubProvider,
} from "../auth/github-provider.js";

// A minimal but structurally-valid PEM so isGithubAppConfigured treats it as real.
const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";

describe("GitHub App configuration gating", () => {
  it("treats the dev placeholder private key as NOT configured", () => {
    // loadConfig()'s default githubPrivateKey is the "test-private-key" placeholder.
    expect(isGithubAppConfigured(loadConfig())).toBe(false);
  });

  it("treats a PEM private key as configured", () => {
    expect(isGithubAppConfigured(loadConfig({ githubPrivateKey: FAKE_PEM }))).toBe(true);
  });

  it("accepts an escaped-newline PEM (env-var form)", () => {
    const escaped = FAKE_PEM.replace(/\n/g, "\\n");
    expect(isGithubAppConfigured(loadConfig({ githubPrivateKey: escaped }))).toBe(true);
  });
});

describe("StubGithubProvider", () => {
  const stub = new StubGithubProvider();

  it("returns no installations instead of throwing", async () => {
    await expect(stub.listInstallations()).resolves.toEqual([]);
    await expect(stub.listInstallationRepos(1)).resolves.toEqual([]);
  });

  it("fails with a clear message for operations that require GitHub", async () => {
    expect(() => stub.getAuthorizeUrl("s")).toThrow(/not configured/i);
    await expect(stub.getCloneInfo(1, "a/b")).rejects.toThrow(/not configured/i);
    await expect(
      stub.openPullRequest({
        installationId: 1,
        repoFullName: "a/b",
        head: "h",
        base: "b",
        title: "t",
      }),
    ).rejects.toThrow(/not configured/i);
  });
});
