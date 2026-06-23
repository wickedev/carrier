// AES-256-GCM encryption for config secrets (env var values flagged `secret`).
// The 32-byte key is derived from Config.configSecretKey via SHA-256, so any
// secret string length is accepted. encrypt() returns iv:authTag:ciphertext as
// hex-joined fields; decrypt() reverses it. Non-secret env values are stored as
// plaintext and never pass through here.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Config } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM

export class ConfigCrypto {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Derive a fixed 32-byte key regardless of the secret's length.
    this.key = createHash("sha256").update(secret).digest();
  }

  /** Encrypt a plaintext string → "iv:authTag:ciphertext" (all hex). */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plain, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString("hex"),
      authTag.toString("hex"),
      ciphertext.toString("hex"),
    ].join(":");
  }

  /** Decrypt an "iv:authTag:ciphertext" string back to plaintext. */
  decrypt(s: string): string {
    const parts = s.split(":");
    if (parts.length !== 3) {
      throw new Error("invalid ciphertext format");
    }
    const [ivHex, tagHex, dataHex] = parts as [string, string, string];
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");
    const ciphertext = Buffer.from(dataHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  }
}

export function createConfigCrypto(config: Config): ConfigCrypto {
  return new ConfigCrypto(config.configSecretKey);
}
