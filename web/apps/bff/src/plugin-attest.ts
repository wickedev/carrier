// Detached attestation utilities for the plugin marketplace.
//
// Integrity and signature are kept OUT of the manifest (OCI/Sigstore shape): a
// manifest cannot contain a hash/signature of a bundle that includes the
// manifest itself. Instead:
//   - the manifest commits to each referenced artifact by its content digest;
//   - the version identity is `manifest_digest = "sha256-" + sha256(canonical
//     (manifest))`, computed over the manifest JSON with object keys sorted
//     recursively so it is stable regardless of key insertion order;
//   - the signature is a DETACHED ed25519 signature over the manifest digest,
//     stored separately (registry field / carrier-plugin.sig), never inside the
//     manifest.
//
// The same three checks (recompute digest → verify detached signature → verify
// each artifact's bytes against its recorded digest) run at publish, install,
// and every runtime load.

import { createHash, sign, verify } from "node:crypto";

/** Recursively sort object keys so the serialization is independent of insertion
 *  order. Arrays preserve order (they are semantically ordered); primitives pass
 *  through unchanged. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortValue(obj[key]);
    }
    return out;
  }
  return value;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The version identity: `"sha256-" + sha256(canonicalJSON(manifest))`. The
 *  manifest passed here MUST NOT carry its own digest/signature. */
export function manifestDigest(manifest: unknown): string {
  return `sha256-${sha256Hex(canonicalJSON(manifest))}`;
}

/** The content digest of an artifact's raw bytes: `"sha256-" + sha256(bytes)`. */
export function artifactDigest(bytes: Buffer | Uint8Array): string {
  return `sha256-${sha256Hex(Buffer.from(bytes))}`;
}

/** Produce a detached ed25519 signature over the manifest digest (base64). The
 *  private key is a PEM-encoded PKCS#8 ed25519 key. Used by tests/publishers. */
export function signDetached(digest: string, privateKeyPem: string): string {
  const signature = sign(null, Buffer.from(digest), privateKeyPem);
  return signature.toString("base64");
}

/** Verify a detached ed25519 signature (base64) over the manifest digest against
 *  the publisher's PEM-encoded public key. Returns false on any failure. */
export function verifyDetachedSignature(
  digest: string,
  signature: string,
  publisherPublicKeyPem: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(digest),
      publisherPublicKeyPem,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
