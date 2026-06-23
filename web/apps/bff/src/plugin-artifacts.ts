// A trivial content-addressed artifact store for plugin WASM bytes. Artifacts
// are written under a local directory keyed by their content digest, so the
// stored bytes are exactly what the manifest committed to. The recorded
// `artifact_ref` is the digest-derived key; resolution is digest → file.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class PluginArtifactStore {
  constructor(private readonly rootDir: string) {}

  /** Map a content digest (e.g. "sha256-<hex>") to a filesystem-safe key. */
  private keyFor(digest: string): string {
    return digest.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  private pathFor(ref: string): string {
    return join(this.rootDir, ref);
  }

  /** Persist artifact bytes keyed by digest; returns the artifact_ref. */
  async put(digest: string, bytes: Buffer): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    const ref = this.keyFor(digest);
    await writeFile(this.pathFor(ref), bytes);
    return ref;
  }

  /** Read previously-stored artifact bytes by ref, or null if absent. */
  async get(ref: string): Promise<Buffer | null> {
    const p = this.pathFor(ref);
    if (!existsSync(p)) return null;
    return readFile(p);
  }
}
