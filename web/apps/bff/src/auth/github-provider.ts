// GitHub integration behind an injectable interface so live OAuth/App calls are
// thin and fully mockable in tests. The default implementation uses
// @octokit/oauth-app + octokit; tests inject a fake.

import { OAuthApp } from "@octokit/oauth-app";
import { createAppAuth } from "@octokit/auth-app";
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
  /**
   * Open a pull request for a freshly-pushed branch on a repo-bound project's
   * repository, via the installation token. Returns the PR's html URL.
   */
  openPullRequest(input: OpenPullRequestInput): Promise<{ url: string }>;
}

export interface OpenPullRequestInput {
  installationId: number;
  repoFullName: string;
  /** Source branch (e.g. carrier/<session>) — must already exist on the remote. */
  head: string;
  /** Target branch (the repo's default branch). */
  base: string;
  title: string;
  body?: string;
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

  /** App-authenticated Octokit (JWT) — used to enumerate installations. */
  private appOctokit(): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.cfg.githubAppId,
        privateKey: normalizePrivateKey(this.cfg.githubPrivateKey),
      },
    });
  }

  /** Installation-scoped Octokit (acts as the App on a specific installation). */
  private installationOctokit(installationId: number): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.cfg.githubAppId,
        privateKey: normalizePrivateKey(this.cfg.githubPrivateKey),
        installationId,
      },
    });
  }

  async listInstallations(): Promise<GithubInstallationRef[]> {
    const octokit = this.appOctokit();
    const installs = await octokit.paginate(
      octokit.rest.apps.listInstallations,
      { per_page: 100 },
    );
    return installs.map((i) => {
      // account is a union (User | Enterprise | null); both carry a name, users
      // carry a login. Read defensively.
      const acct = i.account as { login?: string; name?: string } | null;
      return {
        installationId: i.id,
        accountLogin: acct?.login ?? acct?.name ?? "",
      };
    });
  }

  async listInstallationRepos(installationId: number): Promise<GithubRepoRef[]> {
    const octokit = this.installationOctokit(installationId);
    const repos = await octokit.paginate(
      octokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    return repos.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
    }));
  }

  async getCloneInfo(
    installationId: number,
    repoFullName: string,
  ): Promise<{ token: string; cloneUrl: string }> {
    // Mint a short-lived installation access token and embed it in the https
    // clone URL: https://x-access-token:<token>@github.com/<repo>.git
    const auth = createAppAuth({
      appId: this.cfg.githubAppId,
      privateKey: normalizePrivateKey(this.cfg.githubPrivateKey),
    });
    const { token } = await auth({ type: "installation", installationId });
    return {
      token,
      cloneUrl: `https://x-access-token:${token}@github.com/${repoFullName}.git`,
    };
  }

  async openPullRequest(
    input: OpenPullRequestInput,
  ): Promise<{ url: string }> {
    const octokit = this.installationOctokit(input.installationId);
    const [owner, repo] = input.repoFullName.split("/");
    const { data } = await octokit.rest.pulls.create({
      owner: owner ?? "",
      repo: repo ?? "",
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { url: data.html_url };
  }
}

/**
 * GitHub private keys are PEM blocks; when carried through an env var the
 * newlines are commonly escaped as "\n". Restore them so @octokit/auth-app can
 * parse the key.
 */
function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

/**
 * Whether a real GitHub App is configured. A genuine App private key is a PEM
 * block ("-----BEGIN ... PRIVATE KEY-----"); the dev/test default is a
 * placeholder string. Without a real key, authenticating to GitHub throws, so
 * we fall back to {@link StubGithubProvider} rather than 500 on every call.
 */
export function isGithubAppConfigured(cfg: Config): boolean {
  return normalizePrivateKey(cfg.githubPrivateKey).includes("PRIVATE KEY");
}

/**
 * No-op provider used when the GitHub App is not configured (e.g. local dev with
 * no GITHUB_* credentials). Listing endpoints return empty so the UI degrades to
 * "no installations" instead of surfacing a 500 from Octokit trying to sign a
 * JWT with a placeholder key. Operations that genuinely require GitHub fail with
 * a clear, actionable message.
 */
export class StubGithubProvider implements GithubProvider {
  private notConfigured(): never {
    throw new Error(
      "GitHub is not configured in this environment. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY (and GITHUB_CLIENT_ID/SECRET) to enable GitHub features.",
    );
  }
  getAuthorizeUrl(): string {
    this.notConfigured();
  }
  async exchangeCode(): Promise<{ user: GithubUser; orgs: GithubOrgRef[] }> {
    this.notConfigured();
  }
  async listInstallations(): Promise<GithubInstallationRef[]> {
    return [];
  }
  async listInstallationRepos(): Promise<GithubRepoRef[]> {
    return [];
  }
  async getCloneInfo(): Promise<{ token: string; cloneUrl: string }> {
    this.notConfigured();
  }
  async openPullRequest(): Promise<{ url: string }> {
    this.notConfigured();
  }
}
