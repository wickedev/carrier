import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createDb, MIGRATIONS, schema } from "../db/client.js";
import { account } from "../db/schema.js";

const AVATAR = "https://www.gravatar.com/avatar/x?d=identicon";

describe("account schema migration + email uniqueness", () => {
  it("partial unique index rejects a second PASSWORD account with the same email", async () => {
    const db = await createDb();
    await db.insert(account).values({
      id: randomUUID(),
      githubUserId: null,
      login: "a",
      avatarUrl: AVATAR,
      email: "dup@example.com",
      passwordHash: "scrypt$aa$bb",
    });
    await expect(
      db.insert(account).values({
        id: randomUUID(),
        githubUserId: null,
        login: "b",
        avatarUrl: AVATAR,
        email: "dup@example.com",
        passwordHash: "scrypt$cc$dd",
      }),
    ).rejects.toThrow();
  });

  it("leaves GitHub accounts (null password hash) unconstrained on email", async () => {
    const db = await createDb();
    // Two GitHub accounts may share an email (the partial index excludes them).
    for (const gh of ["gh-1", "gh-2"]) {
      await db.insert(account).values({
        id: randomUUID(),
        githubUserId: gh,
        login: gh,
        avatarUrl: AVATAR,
        email: "shared@example.com",
        passwordHash: null,
      });
    }
    const rows = await db
      .select()
      .from(account)
      .where(eq(account.email, "shared@example.com"));
    expect(rows).toHaveLength(2);
  });

  it("migrates an existing OLD-schema database (NOT NULL github id, no password_hash)", async () => {
    // Simulate a persisted/production DB created before email/password auth.
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE account (
        id TEXT PRIMARY KEY,
        github_user_id TEXT NOT NULL UNIQUE,
        login TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT NOT NULL,
        email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pg.exec(
      `INSERT INTO account (id, github_user_id, login, avatar_url, email)
       VALUES ('1', 'gh-old', 'olduser', '${AVATAR}', 'old@example.com');`,
    );

    // Applying the migrations must converge the schema without data loss.
    await pg.exec(MIGRATIONS);
    const db = drizzle(pg, { schema });

    // password_hash now exists and github_user_id is nullable: a password
    // account (null github id) inserts successfully.
    await db.insert(account).values({
      id: "2",
      githubUserId: null,
      login: "newpwuser",
      avatarUrl: AVATAR,
      email: "new@example.com",
      passwordHash: "scrypt$aa$bb",
    });
    const rows = await db.select().from(account);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "1")?.githubUserId).toBe("gh-old"); // preserved
  });
});
