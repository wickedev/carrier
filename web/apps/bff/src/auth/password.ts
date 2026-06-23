// Password hashing for email/password accounts, using Node's scrypt (no external
// dependency). Hashes are stored as `scrypt$<saltHex>$<keyHex>` and verified in
// constant time.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

/** Hash a plaintext password with a random salt. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(plain, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Verify a plaintext password against a stored `scrypt$salt$key` hash. */
export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  const key = (await scryptAsync(plain, salt, expected.length)) as Buffer;
  return key.length === expected.length && timingSafeEqual(key, expected);
}
