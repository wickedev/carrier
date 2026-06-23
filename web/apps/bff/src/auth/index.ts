// Auth routes + middleware: GitHub OAuth login/callback (with state/CSRF),
// logout, the session-loading middleware, and GET /me.

import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  LoginSchema,
  MeSchema,
  RegisterSchema,
  type Me,
  type Org,
  type Role,
} from "@carrier/contract";
import type { AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import type { Config } from "../config.js";
import { account, membership, org } from "../db/schema.js";
import { readSession, setSession, clearSession } from "./session.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { GithubUser, GithubOrgRef } from "./github-provider.js";

const STATE_COOKIE = "carrier_oauth_state";

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Begin OAuth: set a state cookie and redirect to GitHub.
  app.get("/github", (c) => {
    const { github, config } = c.var.deps;
    const state = randomUUID();
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.secureCookies,
      path: "/",
      maxAge: 600,
    });
    return c.redirect(github.getAuthorizeUrl(state));
  });

  // OAuth callback: verify state, exchange code, provision, set session.
  app.get("/github/callback", async (c) => {
    const { github, config, db } = c.var.deps;
    const code = c.req.query("code");
    const state = c.req.query("state");
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });

    if (!code || !state || !expected || state !== expected) {
      return c.json({ error: "invalid_state" }, 403);
    }

    const { user, orgs } = await github.exchangeCode(code);
    const accountId = await provisionAccount(db, user, orgs);
    await setSession(c, config, { accountId });

    const redirectTo = c.req.query("redirect") ?? "/";
    return c.redirect(redirectTo);
  });

  // Email/password registration → provisions a local account + personal org.
  app.post("/register", async (c) => {
    const { db, config } = c.var.deps;
    const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const email = parsed.data.email.toLowerCase();

    // Only a PASSWORD account collides — consistent with the partial unique index
    // (a GitHub account may share this email without blocking registration).
    const taken = await db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.email, email), isNotNull(account.passwordHash)))
      .limit(1);
    if (taken[0]) return c.json({ error: "email_taken" }, 409);

    let accountId: string;
    try {
      accountId = await provisionLocalAccount(db, {
        email,
        password: parsed.data.password,
        name: parsed.data.name,
      });
    } catch (err) {
      // The partial unique index is the real guard: a concurrent registration
      // racing past the pre-check trips a unique violation → email_taken.
      if (isUniqueViolation(err)) return c.json({ error: "email_taken" }, 409);
      throw err;
    }
    await setSession(c, config, { accountId });
    return c.json({ ok: true }, 201);
  });

  // Email/password login.
  app.post("/login", async (c) => {
    const { db, config } = c.var.deps;
    const parsed = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const email = parsed.data.email.toLowerCase();

    // Resolve THE password account for this email (a GitHub account sharing the
    // email has no password and must not shadow it) — matches the partial index.
    const rows = await db
      .select()
      .from(account)
      .where(and(eq(account.email, email), isNotNull(account.passwordHash)))
      .limit(1);
    const acct = rows[0];
    // Same response whether the account is missing or the password is wrong.
    if (!acct || !(await verifyPassword(parsed.data.password, acct.passwordHash))) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    await setSession(c, config, { accountId: acct.id });
    return c.json({ ok: true });
  });

  app.post("/logout", (c) => {
    clearSession(c, c.var.deps.config);
    return c.json({ ok: true });
  });

  return app;
}

/** Loads the session account onto c.var.account, or 401s. */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { config, db } = c.var.deps;
    const sess = await readSession(c, config);
    if (!sess) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db
      .select()
      .from(account)
      .where(eq(account.id, sess.accountId))
      .limit(1);
    const acct = rows[0];
    if (!acct) {
      clearSession(c, config);
      return c.json({ error: "unauthenticated" }, 401);
    }
    c.set("account", acct);
    await next();
  };
}

export function meRoute(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth());
  app.get("/", async (c) => {
    const acct = c.var.account;
    const { db } = c.var.deps;
    const me: Me = {
      account: {
        id: acct.id,
        login: acct.login,
        name: acct.name,
        avatarUrl: acct.avatarUrl,
      },
      orgs: await listOrgsForAccount(db, acct.id),
    };
    return c.json(MeSchema.parse(me));
  });
  return app;
}

// ── helpers ────────────────────────────────────────────────────────────────

export async function listOrgsForAccount(
  db: AppEnv["Variables"]["deps"]["db"],
  accountId: string,
): Promise<Org[]> {
  const rows = await db
    .select({
      id: org.id,
      kind: org.kind,
      slug: org.slug,
      name: org.name,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(org, eq(org.id, membership.orgId))
    .where(eq(membership.accountId, accountId));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "personal" ? "personal" : "org",
    slug: r.slug,
    name: r.name,
    role: (r.role as Role) ?? "member",
  }));
}

/** Whether err is a Postgres/PGlite unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code?: unknown }).code === "23505";
  }
  return /unique/i.test(String(err));
}

/** A deterministic Gravatar identicon URL for an email (valid URL, no network
 *  dependency to render a default). */
function gravatarUrl(email: string): string {
  const hash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?d=identicon`;
}

/** Find a free org slug derived from base (appends -2, -3, … on collision). */
async function uniqueSlug(db: Db, base: string): Promise<string> {
  const root =
    base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "user";
  let slug = root;
  for (let n = 2; ; n++) {
    const hit = await db
      .select({ id: org.id })
      .from(org)
      .where(eq(org.slug, slug))
      .limit(1);
    if (!hit[0]) return slug;
    slug = `${root}-${n}`;
  }
}

/** Provision an email/password account + its personal org. Returns the id. */
export async function provisionLocalAccount(
  db: Db,
  input: { email: string; password: string; name?: string },
): Promise<string> {
  const email = input.email.toLowerCase();
  const login = await uniqueSlug(db, email.split("@")[0] ?? "user");
  const accountId = randomUUID();
  await db.insert(account).values({
    id: accountId,
    githubUserId: null,
    login,
    name: input.name ?? null,
    avatarUrl: gravatarUrl(email),
    email,
    passwordHash: await hashPassword(input.password),
  });
  const personalId = randomUUID();
  await db.insert(org).values({
    id: personalId,
    kind: "personal",
    githubOrgId: null,
    slug: login,
    name: input.name ?? login,
    ownerAccountId: accountId,
  });
  await db.insert(membership).values({
    accountId,
    orgId: personalId,
    role: "owner",
  });
  return accountId;
}

/** Seed a known dev account so `make dev` can log in immediately. Idempotent —
 *  skips when the account already exists. Never called from tests. */
export async function seedDevUser(db: Db, config: Config): Promise<void> {
  const email = config.devUserEmail.toLowerCase();
  const existing = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.email, email), isNotNull(account.passwordHash)))
    .limit(1);
  if (existing[0]) return;
  await provisionLocalAccount(db, {
    email,
    password: config.devUserPassword,
    name: "Dev User",
  });
}

async function provisionAccount(
  db: AppEnv["Variables"]["deps"]["db"],
  user: GithubUser,
  orgs: GithubOrgRef[],
): Promise<string> {
  const existing = await db
    .select()
    .from(account)
    .where(eq(account.githubUserId, user.githubUserId))
    .limit(1);

  let accountId: string;
  if (existing[0]) {
    accountId = existing[0].id;
    await db
      .update(account)
      .set({
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        email: user.email,
      })
      .where(eq(account.id, accountId));
  } else {
    accountId = randomUUID();
    await db.insert(account).values({
      id: accountId,
      githubUserId: user.githubUserId,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      email: user.email,
    });
    // First login provisions a Personal org context.
    const personalId = randomUUID();
    await db.insert(org).values({
      id: personalId,
      kind: "personal",
      githubOrgId: null,
      slug: user.login,
      name: user.name ?? user.login,
      ownerAccountId: accountId,
    });
    await db.insert(membership).values({
      accountId,
      orgId: personalId,
      role: "owner",
    });
  }

  // Reconcile GitHub org memberships (member role; upsert org + membership).
  for (const o of orgs) {
    const existingOrg = await db
      .select()
      .from(org)
      .where(eq(org.githubOrgId, o.githubOrgId))
      .limit(1);
    let orgId: string;
    if (existingOrg[0]) {
      orgId = existingOrg[0].id;
    } else {
      orgId = randomUUID();
      await db.insert(org).values({
        id: orgId,
        kind: "org",
        githubOrgId: o.githubOrgId,
        slug: o.login,
        name: o.name,
        ownerAccountId: accountId,
      });
    }
    const hasMembership = await db
      .select()
      .from(membership)
      .where(eq(membership.accountId, accountId));
    if (!hasMembership.some((m) => m.orgId === orgId)) {
      await db
        .insert(membership)
        .values({ accountId, orgId, role: "member" });
    }
  }

  return accountId;
}
