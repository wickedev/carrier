import { describe, it, expect } from "vitest";
import { makeHarness, type Harness } from "./harness.js";
import { UsageStore, usageDeltaFromRaw } from "../usage.js";

async function setup(h: Harness) {
  const a = await h.seedAccount("dev");
  const cookie = await h.cookieFor(a.accountId);
  const project = await (
    await h.app.request(`/orgs/${a.orgId}/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "App" }),
    })
  ).json();
  return { cookie, project, org: a.orgId };
}

async function newSession(h: Harness, cookie: string, projectId: string) {
  return (
    await h.app.request(`/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "S" }),
    })
  ).json();
}

describe("usageDeltaFromRaw + UsageStore (task 20)", () => {
  it("extracts deltas from usage / step_finish frames and ignores others", () => {
    expect(
      usageDeltaFromRaw({
        seq: 1,
        kind: "usage",
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 2,
        cache_write_tokens: 1,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      model: undefined,
    });
    expect(usageDeltaFromRaw({ seq: 2, kind: "text", text: "hi" })).toBeNull();
    expect(usageDeltaFromRaw({ seq: 3, kind: "usage" })).toBeNull();
  });

  it("accumulates and prices known models; unknown models cost 0", () => {
    const store = new UsageStore();
    store.add("s1", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4",
    });
    const u = store.forSession("s1");
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(1000);
    // 1k input @ 0.003 + 1k output @ 0.015 = 0.018
    expect(u.costUsd).toBeCloseTo(0.018, 6);

    store.add("s2", {
      inputTokens: 500,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "mystery-model",
    });
    expect(store.forSession("s2").costUsd).toBe(0);
  });

  it("rolls up across sessions", () => {
    const store = new UsageStore();
    store.add("s1", {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    store.add("s2", {
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(store.rollup(["s1", "s2"])).toMatchObject({
      inputTokens: 15,
      outputTokens: 3,
    });
    // Unknown session ids contribute nothing.
    expect(store.rollup(["nope"])).toMatchObject({ inputTokens: 0 });
  });
});

describe("usage accumulated through the SSE relay + rollups (task 20)", () => {
  it("per-session, per-project and per-org usage reflect streamed usage frames", async () => {
    const h = await makeHarness();
    const { cookie, project, org } = await setup(h);
    h.carrier.events = [
      { seq: 1, kind: "status", state: "running" },
      {
        seq: 2,
        kind: "usage",
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
      },
      {
        seq: 3,
        kind: "step_finish",
        input_tokens: 50,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      { seq: 4, kind: "status", state: "idle" },
    ];
    const session = await newSession(h, cookie, project.id);

    // Drain the SSE stream so the relay accumulates usage.
    const ev = await h.app.request(`/sessions/${session.id}/events`, {
      headers: { cookie, accept: "text/event-stream" },
    });
    await ev.text();

    const perSession = await (
      await h.app.request(`/sessions/${session.id}/usage`, {
        headers: { cookie },
      })
    ).json();
    expect(perSession).toMatchObject({
      inputTokens: 150,
      outputTokens: 60,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0, // no model on the frames → cost 0
    });

    const perProject = await (
      await h.app.request(`/projects/${project.id}/usage`, {
        headers: { cookie },
      })
    ).json();
    expect(perProject).toMatchObject({ inputTokens: 150, outputTokens: 60 });

    const perOrg = await (
      await h.app.request(`/orgs/${org}/usage`, { headers: { cookie } })
    ).json();
    expect(perOrg).toMatchObject({ inputTokens: 150, outputTokens: 60 });
  });
});
