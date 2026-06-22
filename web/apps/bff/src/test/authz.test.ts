import { describe, it, expect } from "vitest";
import { makeHarness } from "./harness.js";

async function createProject(
  h: Awaited<ReturnType<typeof makeHarness>>,
  cookie: string,
  org: string,
  name: string,
) {
  const res = await h.app.request(`/orgs/${org}/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res;
}

describe("membership-based authorization", () => {
  it("cross-tenant project access is denied (404)", async () => {
    const h = await makeHarness();
    const alice = await h.seedAccount("alice");
    const bob = await h.seedAccount("bob");
    const aliceCookie = await h.cookieFor(alice.accountId);
    const bobCookie = await h.cookieFor(bob.accountId);

    const created = await createProject(
      h,
      aliceCookie,
      alice.orgId,
      "Secret",
    );
    expect(created.status).toBe(201);
    const project = await created.json();

    // Bob cannot read Alice's project.
    const asBob = await h.app.request(`/projects/${project.id}`, {
      headers: { cookie: bobCookie },
    });
    expect(asBob.status).toBe(404);

    // Alice can.
    const asAlice = await h.app.request(`/projects/${project.id}`, {
      headers: { cookie: aliceCookie },
    });
    expect(asAlice.status).toBe(200);
  });

  it("a plain member cannot archive a project (403); owner/admin can", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const member = await h.seedAccount("member");
    // Put member into owner's org as 'member'.
    await h.addOrgMember(owner.orgId, member.accountId, "member");
    const ownerCookie = await h.cookieFor(owner.accountId);
    const memberCookie = await h.cookieFor(member.accountId);

    const created = await createProject(h, ownerCookie, owner.orgId, "Proj");
    const project = await created.json();

    const memberArchive = await h.app.request(
      `/projects/${project.id}/archive`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    expect(memberArchive.status).toBe(403);

    const ownerArchive = await h.app.request(
      `/projects/${project.id}/archive`,
      { method: "POST", headers: { cookie: ownerCookie } },
    );
    expect(ownerArchive.status).toBe(200);
  });

  it("listing projects of an org you're not in returns 404", async () => {
    const h = await makeHarness();
    const alice = await h.seedAccount("alice");
    const bob = await h.seedAccount("bob");
    const bobCookie = await h.cookieFor(bob.accountId);
    const res = await h.app.request(`/orgs/${alice.orgId}/projects`, {
      headers: { cookie: bobCookie },
    });
    expect(res.status).toBe(404);
  });
});
