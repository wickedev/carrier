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
