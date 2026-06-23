import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  artifactDigest,
  canonicalJSON,
  manifestDigest,
  signDetached,
  verifyDetachedSignature,
} from "../plugin-attest.js";

function pems() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("plugin-attest (detached attestation)", () => {
  const base = {
    name: "acme/lint",
    version: "1.2.0",
    publisher: "acme",
    capabilities: { network: ["api.acme.com"], kv: true },
  };

  it("digest is stable across object key reorder", () => {
    const reordered = {
      capabilities: { kv: true, network: ["api.acme.com"] },
      version: "1.2.0",
      publisher: "acme",
      name: "acme/lint",
    };
    expect(manifestDigest(base)).toBe(manifestDigest(reordered));
    // canonicalJSON sorts keys recursively.
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("a tampered manifest yields a different digest", () => {
    const tampered = { ...base, version: "1.2.1" };
    expect(manifestDigest(tampered)).not.toBe(manifestDigest(base));
  });

  it("array order is preserved (arrays are semantically ordered)", () => {
    const a = { seams: ["a", "b"] };
    const b = { seams: ["b", "a"] };
    expect(manifestDigest(a)).not.toBe(manifestDigest(b));
  });

  it("signature verifies round-trip; wrong key fails", () => {
    const { pub, priv } = pems();
    const digest = manifestDigest(base);
    const sig = signDetached(digest, priv);
    expect(verifyDetachedSignature(digest, sig, pub)).toBe(true);

    const other = pems();
    expect(verifyDetachedSignature(digest, sig, other.pub)).toBe(false);

    // A tampered digest no longer verifies against the original signature.
    const tampered = manifestDigest({ ...base, version: "9.9.9" });
    expect(verifyDetachedSignature(tampered, sig, pub)).toBe(false);
  });

  it("digest prefixes are sha256-", () => {
    expect(manifestDigest(base).startsWith("sha256-")).toBe(true);
    expect(artifactDigest(Buffer.from("hello")).startsWith("sha256-")).toBe(
      true,
    );
  });
});
