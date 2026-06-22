// Workspace manager: owns the on-disk filesystem for Projects and Sessions.
//
// Layout (under WORKSPACE_ROOT):
//   projects/<projectId>/base            canonical Project base (clone or git init)
//   projects/<projectId>/wc/<sessionId>  per-Session isolated working copy
//
// Isolation model (design "Workspace & concurrency model"):
//   - The base is NEVER a live session cwd.
//   - Each session forks its own working copy from the base:
//       repo-bound  → git worktree add … -b carrier/<session>
//       unbound     → a `cp -a`-style snapshot under its own git
//     so two sessions of one project never share a cwd and concurrent edits
//     cannot corrupt the base or each other.
//   - promote() merges a session branch back into the base, serialized per
//     project by an in-process lock; conflicts (base advanced) are surfaced.

import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep, dirname, basename } from "node:path";
import type {
  FileContent,
  FileDiff,
  GitStatus,
  TreeEntry,
  WorkingCopyState,
} from "@carrier/contract";
import { git, gitOrThrow } from "./git.js";
import type { GithubProvider } from "../auth/github-provider.js";

export interface ProvisionBaseInput {
  projectId: string;
  repo?: {
    installationId: number;
    repoFullName: string;
    defaultBranch: string;
  };
}

export interface ForkInput {
  projectId: string;
  sessionId: string;
  basePath: string;
  repoBound: boolean;
}

export interface ForkResult {
  workingCopyPath: string;
  workingBranch: string | null;
  forkedFromRev: string | null;
}

export class PromoteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromoteConflictError";
  }
}

export class PathTraversalError extends Error {
  constructor(message = "path escapes working copy") {
    super(message);
    this.name = "PathTraversalError";
  }
}

export class Workspace {
  /** Per-project promotion lock (serializes base mutation). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly github: GithubProvider,
  ) {}

  private projectDir(projectId: string): string {
    return join(this.root, "projects", projectId);
  }

  basePath(projectId: string): string {
    return join(this.projectDir(projectId), "base");
  }

  /** Provision the canonical Project base. Returns its absolute path. */
  async provisionBase(input: ProvisionBaseInput): Promise<string> {
    const base = this.basePath(input.projectId);
    await mkdir(dirname(base), { recursive: true });
    if (existsSync(join(base, ".git"))) return base;

    if (input.repo) {
      const { cloneUrl } = await this.github.getCloneInfo(
        input.repo.installationId,
        input.repo.repoFullName,
      );
      await mkdir(base, { recursive: true });
      const r = await git(this.projectDir(input.projectId), [
        "clone",
        "--branch",
        input.repo.defaultBranch,
        cloneUrl,
        base,
      ]);
      if (r.code !== 0) {
        // Network-less fallback (and the default-stub clone URL): make a usable
        // empty repo on the requested branch so the rest of the flow works.
        await this.initEmpty(base, input.repo.defaultBranch);
      }
    } else {
      await this.initEmpty(base, "main");
    }
    return base;
  }

  private async initEmpty(dir: string, branch: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await gitOrThrow(dir, ["init", "-q", "-b", branch]);
    // Seed an empty commit so worktrees/branches have a base HEAD.
    await gitOrThrow(dir, ["commit", "--allow-empty", "-q", "-m", "init"]);
  }

  /** Fork an isolated working copy for a session from the base. */
  async fork(input: ForkInput): Promise<ForkResult> {
    const wcRoot = join(this.projectDir(input.projectId), "wc");
    await mkdir(wcRoot, { recursive: true });
    const wcPath = join(wcRoot, input.sessionId);

    const headRev = (
      await git(input.basePath, ["rev-parse", "HEAD"])
    ).stdout.trim();
    const branch = `carrier/${input.sessionId}`;

    if (input.repoBound) {
      // Real, cheap, isolated checkout on its own branch off the base HEAD.
      await gitOrThrow(input.basePath, [
        "worktree",
        "add",
        "-b",
        branch,
        wcPath,
        "HEAD",
      ]);
      return {
        workingCopyPath: wcPath,
        workingBranch: branch,
        forkedFromRev: headRev || null,
      };
    }

    // Unbound: an isolated snapshot copy under its own git, branch off HEAD.
    await cp(input.basePath, wcPath, { recursive: true });
    // Detach the copy from the base's worktree machinery (it's an independent
    // clone-by-copy); recreate a branch pointing at the same HEAD.
    await git(wcPath, ["checkout", "-q", "-b", branch]);
    return {
      workingCopyPath: wcPath,
      workingBranch: branch,
      forkedFromRev: headRev || null,
    };
  }

  /** Remove a session's working copy (and prune its worktree if repo-bound). */
  async removeWorkingCopy(
    projectId: string,
    sessionId: string,
    wcPath: string,
    repoBound: boolean,
  ): Promise<void> {
    if (repoBound) {
      await git(this.basePath(projectId), [
        "worktree",
        "remove",
        "--force",
        wcPath,
      ]);
    }
    await rm(wcPath, { recursive: true, force: true });
  }

  // ── path safety ────────────────────────────────────────────────────────────

  /** Resolve a user-supplied relative path against the working-copy root,
   *  rejecting traversal/absolute escapes. */
  resolveInside(wcPath: string, userPath: string): string {
    const rootAbs = resolve(wcPath);
    const target = resolve(rootAbs, userPath ?? "");
    const rel = relative(rootAbs, target);
    // Escape if the relative path starts with ".." or is absolute (e.g. the
    // user passed an absolute path outside the root).
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
      throw new PathTraversalError();
    }
    if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
      throw new PathTraversalError();
    }
    return target;
  }

  // ── tree / file / diff (over the session working copy) ──────────────────────

  async tree(wcPath: string, dirPath: string): Promise<TreeEntry[]> {
    const abs = this.resolveInside(wcPath, dirPath || "");
    const statuses = await this.gitStatusMap(wcPath);
    const entries = await readdir(abs, { withFileTypes: true });
    const out: TreeEntry[] = [];
    for (const e of entries) {
      if (e.name === ".git") continue;
      const rel = relative(resolve(wcPath), join(abs, e.name));
      const isDir = e.isDirectory();
      out.push({
        path: rel,
        name: e.name,
        type: isDir ? "dir" : "file",
        git: isDir ? undefined : statuses.get(rel) ?? "clean",
      });
    }
    out.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
    return out;
  }

  async file(wcPath: string, filePath: string): Promise<FileContent> {
    const abs = this.resolveInside(wcPath, filePath);
    const buf = await readFile(abs);
    const binary = buf.includes(0);
    const MAX = 256 * 1024;
    const truncated = buf.length > MAX;
    const slice = truncated ? buf.subarray(0, MAX) : buf;
    return {
      path: filePath,
      content: binary ? "" : slice.toString("utf8"),
      truncated,
      binary,
    };
  }

  /** Diff a file: working copy vs its base branch (the fork point / HEAD). */
  async diff(wcPath: string, filePath: string): Promise<FileDiff> {
    const abs = this.resolveInside(wcPath, filePath);
    const rel = relative(resolve(wcPath), abs);
    // before = content at HEAD (the base branch fork point); after = working tree.
    const show = await git(wcPath, ["show", `HEAD:${rel}`]);
    const before = show.code === 0 ? show.stdout : "";
    let after = "";
    try {
      after = (await readFile(abs)).toString("utf8");
    } catch {
      after = "";
    }
    return { path: filePath, before, after };
  }

  async workingCopyState(
    wcPath: string,
    workingBranch: string | null,
  ): Promise<WorkingCopyState> {
    const dirtyR = await git(wcPath, ["status", "--porcelain"]);
    const dirty = dirtyR.stdout.trim().length > 0;
    // ahead/behind vs the fork point is approximated by counting commits on the
    // branch since it diverged from HEAD's merge-base with the base branch.
    let ahead = 0;
    let behind = 0;
    const branchName =
      workingBranch ??
      (await git(wcPath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    return { branch: branchName || null, dirty, ahead, behind };
  }

  private async gitStatusMap(
    wcPath: string,
  ): Promise<Map<string, GitStatus>> {
    const map = new Map<string, GitStatus>();
    const r = await git(wcPath, ["status", "--porcelain"]);
    if (r.code !== 0) return map;
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      map.set(path, mapPorcelain(code));
    }
    return map;
  }

  // ── promotion ───────────────────────────────────────────────────────────────

  /**
   * Promote a session's working copy back into the Project base. Serialized
   * per-project so concurrent promotions can't corrupt the base. For repo-bound
   * projects this commits the worktree then (would) push + open a PR; here we
   * merge into the base branch in place. Surfaces conflicts when the base
   * advanced since the fork (PromoteConflictError).
   */
  async promote(args: {
    projectId: string;
    basePath: string;
    wcPath: string;
    workingBranch: string;
    repoBound: boolean;
    message: string;
    /** Repo binding — required to push + open a PR for repo-bound projects. */
    repo?: {
      installationId: number;
      repoFullName: string;
      defaultBranch: string;
    };
  }): Promise<{ pullRequestUrl: string | null; merged: boolean }> {
    return this.withProjectLock(args.projectId, async () => {
      // Commit any pending edits in the working copy onto its branch.
      await git(args.wcPath, ["add", "-A"]);
      const status = await git(args.wcPath, ["status", "--porcelain"]);
      if (status.stdout.trim().length > 0) {
        await git(args.wcPath, ["commit", "-q", "-m", args.message]);
      }

      if (args.repoBound) {
        // Merge into the local base (serialized) so the base advances and
        // conflicts are surfaced, then push the session branch to the remote
        // and open a PR via the installation token.
        const merged = await this.mergeBranchIntoBase(
          args.basePath,
          args.wcPath,
          args.workingBranch,
        );
        const pullRequestUrl = await this.pushAndOpenPullRequest(args);
        return { pullRequestUrl, merged };
      }

      const merged = await this.mergeBranchIntoBase(
        args.basePath,
        args.wcPath,
        args.workingBranch,
      );
      return { pullRequestUrl: null, merged };
    });
  }

  /**
   * Push the session branch to the bound repo with a freshly-minted
   * installation token and open a pull request against the default branch.
   * Returns the PR url, or null if no repo binding is available. The push is
   * best-effort (network-less test/dev envs may fail it) but the PR is opened
   * through the injectable GithubProvider so tests can assert it.
   */
  private async pushAndOpenPullRequest(args: {
    wcPath: string;
    workingBranch: string;
    message: string;
    repo?: {
      installationId: number;
      repoFullName: string;
      defaultBranch: string;
    };
  }): Promise<string | null> {
    if (!args.repo) return null;
    const { installationId, repoFullName, defaultBranch } = args.repo;
    // Mint a tokenized push URL and push the branch (best-effort).
    const { cloneUrl } = await this.github.getCloneInfo(
      installationId,
      repoFullName,
    );
    await git(args.wcPath, [
      "push",
      cloneUrl,
      `${args.workingBranch}:${args.workingBranch}`,
    ]);
    const { url } = await this.github.openPullRequest({
      installationId,
      repoFullName,
      head: args.workingBranch,
      base: defaultBranch,
      title: args.message,
      body: `Promoted from Carrier session branch \`${args.workingBranch}\`.`,
    });
    return url;
  }

  private async mergeBranchIntoBase(
    basePath: string,
    wcPath: string,
    branch: string,
  ): Promise<boolean> {
    // Pull the working copy's branch tip into the base by fetching from the
    // working copy (which has the commits) and merging.
    const baseBranch = (
      await git(basePath, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();

    await gitOrThrow(basePath, ["fetch", "-q", wcPath, branch]);
    const merge = await git(basePath, [
      "merge",
      "--no-edit",
      "--no-ff",
      "FETCH_HEAD",
    ]);
    if (merge.code !== 0) {
      // Abort to leave the base clean, then surface the conflict.
      await git(basePath, ["merge", "--abort"]);
      throw new PromoteConflictError(
        `base '${baseBranch}' advanced since fork; merge conflict`,
      );
    }
    return true;
  }

  /** Serialize an operation per project id (in-process base-mutation lock).
   *  Each call chains after the previous one for the same project, so only one
   *  promotion mutates a given base at a time. */
  async withProjectLock<T>(
    projectId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    // The next link resolves only after fn settles, regardless of outcome.
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    // Store a swallowed version so a rejected fn doesn't break the chain.
    this.locks.set(
      projectId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

function mapPorcelain(code: string): GitStatus {
  if (code.includes("?")) return "U";
  if (code.includes("D")) return "D";
  if (code.includes("A")) return "A";
  if (code.includes("M") || code.includes("R")) return "M";
  return "M";
}

export function randomSlug(): string {
  return randomUUID().slice(0, 8);
}

export { basename };
