// Thin promise wrapper around git/child_process used by the workspace manager.

import { spawn } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a git command in `cwd`. Never throws on non-zero exit; inspect .code. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return run("git", args, cwd);
}

/** Run git and throw if it exits non-zero (for steps that must succeed). */
export async function gitOrThrow(
  cwd: string,
  args: string[],
): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

export function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        // Deterministic identity so commits succeed in clean test envs.
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Carrier BFF",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "bff@carrier.local",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Carrier BFF",
        GIT_COMMITTER_EMAIL:
          process.env.GIT_COMMITTER_EMAIL ?? "bff@carrier.local",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) =>
      resolve({ code: -1, stdout, stderr: stderr + String(e) }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
  });
}
