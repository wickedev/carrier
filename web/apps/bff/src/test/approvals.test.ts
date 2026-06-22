import { describe, it, expect } from "vitest";
import { makeHarness, type Harness } from "./harness.js";

async function setupSession(h: Harness) {
  const a = await h.seedAccount("dev");
  const cookie = await h.cookieFor(a.accountId);
  const project = await (
    await h.app.request(`/orgs/${a.orgId}/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "App" }),
    })
  ).json();
  const session = await (
    await h.app.request(`/projects/${project.id}/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "S" }),
    })
  ).json();
  return { cookie, session };
}

describe("HITL approvals delivered to Carrier (task 17)", () => {
  it("forwards an approve decision to Carrier correlated by reqId", async () => {
    const h = await makeHarness();
    const { cookie, session } = await setupSession(h);
    const res = await h.app.request(
      `/sessions/${session.id}/approvals/req-7`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ allow: true }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, reqId: "req-7", allow: true });

    expect(h.carrier.approvals).toHaveLength(1);
    expect(h.carrier.approvals[0]).toMatchObject({
      id: "carrier-session-1",
      reqId: "req-7",
      allow: true,
    });
  });

  it("forwards a deny decision", async () => {
    const h = await makeHarness();
    const { cookie, session } = await setupSession(h);
    await h.app.request(`/sessions/${session.id}/approvals/req-9`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ allow: false }),
    });
    expect(h.carrier.approvals[0]).toMatchObject({
      reqId: "req-9",
      allow: false,
    });
  });

  it("rejects an invalid body (400)", async () => {
    const h = await makeHarness();
    const { cookie, session } = await setupSession(h);
    const res = await h.app.request(`/sessions/${session.id}/approvals/r`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(h.carrier.approvals).toHaveLength(0);
  });
});
