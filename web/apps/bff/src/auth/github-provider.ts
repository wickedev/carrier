// GitHub integration behind an injectable interface so live OAuth/App calls are
// thin and fully mockable in tests. The default implementation uses
// @octokit/oauth-app + octokit; tests inject a fake.

import { OAuthApp } from "@octokit/oauth-app";
import { Octokit } from "octokit";
import type { Config } from "../config.js";

export interface GithubUser {
  githubUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string;
  email: string | null;
}

export interface GithubOrgRef {
  githubOrgId: string;
  login: string;
  name: string;
}

export interface GithubRepoRef {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GithubInstallationRef {
  installationId: number;
  accountLogin: string;
}

/** Everything the BFF needs from GitHub, abstracted for testing. */
export interface GithubProvider {
  /** Build the OAuth authorize URL (with state) the browser is redirected to. */
  getAuthorizeUrl(state: string): string;
  /** Exchange an OAuth code for the authenticated user + their orgs. */
  exchangeCode(code: string): Promise<{ user: GithubUser; orgs: GithubOrgRef[] }>;
  /** List installations of the GitHub App accessible to a user token (or all). */
  listInstallations(): Promise<GithubInstallationRef[]>;
  /** List repos a given installation grants access to. */
  listInstallationRepos(installationId: number): Promise<GithubRepoRef[]>;
  /** Mint a short-lived installation token + an https clone URL for a repo. */
  getCloneInfo(
    installationId: number,
    repoFullName: string,
  ): Promise<{ token: string; cloneUrl: string }>;
}

export class OctokitGithubProvider implements GithubProvider {
  private readonly oauth: OAuthApp;
  constructor(private readonly cfg: Config) {
    this.oauth = new OAuthApp({
      clientId: cfg.githubClientId,
      clientSecret: cfg.githubClientSecret,
    });
  }

  getAuthorizeUrl(state: string): string {
    const { url } = this.oauth.getWebFlowAuthorizationUrl({
      state,
      scopes: ["read:user", "read:org", "user:email"],
    });
    return url;
  }

  async exchangeCode(
    code: string,
  ): Promise<{ user: GithubUser; orgs: GithubOrgRef[] }> {
    const { authentication } = await this.oauth.createToken({ code });
    const octokit = new Octokit({ auth: authentication.token });
    const { data: u } = await octokit.rest.users.getAuthenticated();
    const { data: orgs } = await octokit.rest.orgs.listForAuthenticatedUser();
    return {
      user: {
        githubUserId: String(u.id),
        login: u.login,
        name: u.name ?? null,
        avatarUrl: u.avatar_url,
        email: u.email ?? null,
      },
      orgs: orgs.map((o) => ({
        githubOrgId: String(o.id),
        login: o.login,
        name: o.login,
      })),
    };
  }

  async listInstallations(): Promise<GithubInstallationRef[]> {
    // Requires app auth; stubbed thin for the default impl (mocked in tests).
    return [];
  }

  async listInstallationRepos(): Promise<GithubRepoRef[]> {
    return [];
  }

  async getCloneInfo(
    _installationId: number,
    repoFullName: string,
  ): Promise<{ token: string; cloneUrl: string }> {
    // Real impl would mint an installation token via @octokit/auth-app and
    // build https://x-access-token:<token>@github.com/<repo>.git. Stubbed here.
    return {
      token: "stub-installation-token",
      cloneUrl: `https://github.com/${repoFullName}.git`,
    };
  }
}
