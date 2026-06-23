import { describe, it, expect } from "vitest";
import {
  makeHarness,
  makeFakeGithub,
  defaultGithubState,
  extractSessionCookie,
} from "./harness.js";
import { eq } from "drizzle-orm";
import { account, org } from "../db/schema.js";

describe("auth: OAuth state/CSRF + cookie session", () => {
  it("/auth/github sets a state cookie and redirects to GitHub", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/auth/github");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("github.com/login/oauth/authorize");
    expect(res.headers.get("set-cookie")).toContain("carrier_oauth_state=");
  });

  it("callback rejects a mismatched state (CSRF)", async () => {
    const h = await makeHarness();
    const begin = await h.app.request("/auth/github");
    const stateCookie =
      begin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await h.app.request(
      "/auth/github/callback?code=abc&state=WRONG",
      { headers: { cookie: stateCookie } },
    );
    expect(res.status).toBe(403);
  });

  it("callback with matching state provisions account + personal org and sets session", async () => {
    const h = await makeHarness();
    const begin = await h.app.request("/auth/github");
    const setCookie = begin.headers.get("set-cookie") ?? "";
    const stateCookie = setCookie.split(";")[0] ?? "";
    const state = stateCookie.split("=")[1] ?? "";

    const res = await h.app.request(
      `/auth/github/callback?code=abc&state=${state}`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const sessionCookie = res.headers.get("set-cookie") ?? "";
    expect(sessionCookie).toContain("carrier_session=");
    expect(sessionCookie.toLowerCase()).toContain("httponly");

    // Account + personal org created.
    const accts = await h.db
      .select()
      .from(account)
      .where(eq(account.githubUserId, "gh-1"));
    expect(accts.length).toBe(1);
    const orgs = await h.db
      .select()
      .from(org)
      .where(eq(org.ownerAccountId, accts[0]!.id));
    expect(orgs.some((o) => o.kind === "personal")).toBe(true);

    // /me works with the session cookie.
    const cookie = extractSessionCookie(sessionCookie);
    const me = await h.app.request("/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.account.login).toBe("octocat");
    expect(body.orgs.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects /me without a session cookie", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/me");
    expect(res.status).toBe(401);
  });

  it("logout clears the cookie", async () => {
    const h = await makeHarness();
    const { accountId } = await h.seedAccount("alice");
    const cookie = await h.cookieFor(accountId);
    const res = await h.app.request("/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("carrier_session=");
  });

  it("reconciles GitHub orgs into memberships on login", async () => {
    const state = defaultGithubState();
    state.exchange.orgs = [
      { githubOrgId: "gh-org-9", login: "acme", name: "Acme" },
    ];
    const h = await makeHarness({ github: makeFakeGithub(state) });
    const begin = await h.app.request("/auth/github");
    const stateCookie = begin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const st = stateCookie.split("=")[1] ?? "";
    const res = await h.app.request(
      `/auth/github/callback?code=abc&state=${st}`,
      { headers: { cookie: stateCookie } },
    );
    const cookie = extractSessionCookie(res.headers.get("set-cookie"));
    const me = await h.app.request("/me", { headers: { cookie } });
    const body = await me.json();
    expect(body.orgs.some((o: { slug: string }) => o.slug === "acme")).toBe(
      true,
    );
  });
});

describe("auth: email/password", () => {
  it("register provisions an account + personal org and sets a session", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "Alice@Example.com",
        password: "correct horse battery",
        name: "Alice",
      }),
    });
    expect(res.status).toBe(201);
    const cookie = extractSessionCookie(res.headers.get("set-cookie"));
    expect(cookie).toContain("carrier_session=");

    // The session works against /me.
    const me = await h.app.request("/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.account.name).toBe("Alice");
    expect(body.orgs).toHaveLength(1);
    expect(body.orgs[0].kind).toBe("personal");

    // Email is normalized to lowercase.
    const rows = await h.db.select().from(account);
    expect(rows[0]?.email).toBe("alice@example.com");
    expect(rows[0]?.githubUserId).toBeNull();
    expect(rows[0]?.passwordHash).toMatch(/^scrypt\$/);
  });

  it("login succeeds with the right password and rejects a wrong one", async () => {
    const h = await makeHarness();
    await h.app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", password: "supersecret1" }),
    });

    const ok = await h.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", password: "supersecret1" }),
    });
    expect(ok.status).toBe(200);
    expect(extractSessionCookie(ok.headers.get("set-cookie"))).toContain(
      "carrier_session=",
    );

    const bad = await h.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", password: "wrong" }),
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toBe("invalid_credentials");

    // Unknown email yields the same 401 (no account enumeration).
    const unknown = await h.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "x" }),
    });
    expect(unknown.status).toBe(401);
  });

  it("register rejects a duplicate email (409) and a weak password (400)", async () => {
    const h = await makeHarness();
    const body = JSON.stringify({ email: "dup@example.com", password: "longenough1" });
    const first = await h.app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);
    const dup = await h.app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("email_taken");

    const weak = await h.app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "weak@example.com", password: "short" }),
    });
    expect(weak.status).toBe(400);
  });

  it("seedDevUser provisions a known account idempotently", async () => {
    const h = await makeHarness();
    const { seedDevUser } = await import("../auth/index.js");
    const cfg = { ...h.config, devUserEmail: "dev@carrier.local", devUserPassword: "carrierdev" };
    await seedDevUser(h.db, cfg);
    await seedDevUser(h.db, cfg); // idempotent — no duplicate
    const rows = await h.db
      .select()
      .from(account)
      .where(eq(account.email, "dev@carrier.local"));
    expect(rows).toHaveLength(1);

    const login = await h.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dev@carrier.local", password: "carrierdev" }),
    });
    expect(login.status).toBe(200);
  });
});
