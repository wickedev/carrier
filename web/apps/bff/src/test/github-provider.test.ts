import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import {
  isGithubAppConfigured,
  OctokitGithubProvider,
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

describe("OctokitGithubProvider with no App configured", () => {
  // Placeholder App key (dev default) but real-looking OAuth client creds.
  const provider = new OctokitGithubProvider(
    loadConfig({ githubClientId: "Iv1.abc123", githubClientSecret: "shh" }),
  );

  it("returns no installations instead of throwing", async () => {
    await expect(provider.listInstallations()).resolves.toEqual([]);
    await expect(provider.listInstallationRepos(1)).resolves.toEqual([]);
  });

  it("fails App-only operations (clone/PR) with a clear message", async () => {
    await expect(provider.getCloneInfo(1, "a/b")).rejects.toThrow(/App is not configured/i);
    await expect(
      provider.openPullRequest({
        installationId: 1,
        repoFullName: "a/b",
        head: "h",
        base: "b",
        title: "t",
      }),
    ).rejects.toThrow(/App is not configured/i);
  });

  it("KEEPS GitHub OAuth login working (it is independent of the App key)", () => {
    // Regression: missing App private key must not disable OAuth login.
    const url = provider.getAuthorizeUrl("state-xyz");
    expect(url).toContain("github.com/login/oauth/authorize");
    expect(url).toContain("Iv1.abc123");
    expect(url).toContain("state-xyz");
  });
});
