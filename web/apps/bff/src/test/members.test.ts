import { describe, it, expect } from "vitest";
import { makeHarness } from "./harness.js";

describe("org member management (task 21)", () => {
  it("lists members (owner sees themselves)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const res = await h.app.request(`/orgs/${owner.orgId}/members`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const members = await res.json();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ login: "owner", role: "owner" });
  });

  it("owner/admin can add a member by login; reconciles the membership table", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const newbie = await h.seedAccount("newbie"); // exists as its own personal org
    const cookie = await h.cookieFor(owner.accountId);

    const res = await h.app.request(`/orgs/${owner.orgId}/members`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ login: "newbie", role: "member" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      accountId: newbie.accountId,
      login: "newbie",
      role: "member",
    });

    const list = await (
      await h.app.request(`/orgs/${owner.orgId}/members`, {
        headers: { cookie },
      })
    ).json();
    expect(list.map((m: { login: string }) => m.login).sort()).toEqual([
      "newbie",
      "owner",
    ]);
  });

  it("adding an existing member updates their role (no duplicate rows)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const member = await h.seedAccount("member");
    await h.addOrgMember(owner.orgId, member.accountId, "member");
    const cookie = await h.cookieFor(owner.accountId);

    const res = await h.app.request(`/orgs/${owner.orgId}/members`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ login: "member", role: "admin" }),
    });
    expect(res.status).toBe(200);

    const list = await (
      await h.app.request(`/orgs/${owner.orgId}/members`, {
        headers: { cookie },
      })
    ).json();
    const m = list.filter((x: { login: string }) => x.login === "member");
    expect(m).toHaveLength(1);
    expect(m[0].role).toBe("admin");
  });

  it("a plain member cannot add or remove members (403)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const member = await h.seedAccount("member");
    const target = await h.seedAccount("target");
    await h.addOrgMember(owner.orgId, member.accountId, "member");
    await h.addOrgMember(owner.orgId, target.accountId, "member");
    const memberCookie = await h.cookieFor(member.accountId);

    const add = await h.app.request(`/orgs/${owner.orgId}/members`, {
      method: "POST",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({ login: "target", role: "admin" }),
    });
    expect(add.status).toBe(403);

    const del = await h.app.request(
      `/orgs/${owner.orgId}/members/${target.accountId}`,
      { method: "DELETE", headers: { cookie: memberCookie } },
    );
    expect(del.status).toBe(403);
  });

  it("owner/admin can remove a member", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const member = await h.seedAccount("member");
    await h.addOrgMember(owner.orgId, member.accountId, "member");
    const cookie = await h.cookieFor(owner.accountId);

    const del = await h.app.request(
      `/orgs/${owner.orgId}/members/${member.accountId}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(200);

    const list = await (
      await h.app.request(`/orgs/${owner.orgId}/members`, {
        headers: { cookie },
      })
    ).json();
    expect(list.some((m: { login: string }) => m.login === "member")).toBe(
      false,
    );
  });

  it("cannot remove the org owner (409)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const del = await h.app.request(
      `/orgs/${owner.orgId}/members/${owner.accountId}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(409);
  });
});
