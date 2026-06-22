// Auth routes + middleware: GitHub OAuth login/callback (with state/CSRF),
// logout, the session-loading middleware, and GET /me.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { MeSchema, type Me, type Org, type Role } from "@carrier/contract";
import type { AppEnv } from "../context.js";
import { account, membership, org } from "../db/schema.js";
import { readSession, setSession, clearSession } from "./session.js";
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
