import { describe, it, expect } from "vitest";
import { makeHarness, type Harness } from "./harness.js";
import { normalizeEvent } from "../carrier.js";
import type { RawCarrierEvent } from "@carrier/carrier-client";

async function setupSession(h: Harness) {
  const a = await h.seedAccount("dev");
  const cookie = await h.cookieFor(a.accountId);
  const proj = await (
    await h.app.request(`/orgs/${a.orgId}/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "App" }),
    })
  ).json();
  const session = await (
    await h.app.request(`/projects/${proj.id}/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "S" }),
    })
  ).json();
  return { cookie, session };
}

describe("normalizeEvent: snake→camel mapping", () => {
  it("maps tool_result.is_error → isError", () => {
    const raw: RawCarrierEvent = {
      seq: 1,
      kind: "tool_result",
      id: "t1",
      content: "out",
      is_error: true,
    };
    expect(normalizeEvent(raw)).toEqual({
      seq: 1,
      kind: "tool_result",
      id: "t1",
      content: "out",
      isError: true,
    });
  });

  it("maps approval_request.req_id → reqId", () => {
    const raw: RawCarrierEvent = {
      seq: 2,
      kind: "approval_request",
      req_id: "r9",
      tool: "bash",
      resource: "rm -rf",
      reason: "danger",
    };
    expect(normalizeEvent(raw)).toEqual({
      seq: 2,
      kind: "approval_request",
      reqId: "r9",
      tool: "bash",
      resource: "rm -rf",
      reason: "danger",
    });
  });

  it("parses tool_call input from JSON text", () => {
    const raw: RawCarrierEvent = {
      seq: 3,
      kind: "tool_call",
      id: "c1",
      name: "edit",
      text: JSON.stringify({ path: "a.ts" }),
    };
    const ev = normalizeEvent(raw);
    expect(ev).toMatchObject({ kind: "tool_call", input: { path: "a.ts" } });
  });

  it("drops unknown kinds", () => {
    expect(normalizeEvent({ seq: 1, kind: "mystery" })).toBeNull();
  });
});

describe("SSE relay: history-then-live ordering + dedupe", () => {
  it("relays normalized events in seq order over SSE", async () => {
    const h = await makeHarness();
    h.carrier.events = [
      { seq: 1, kind: "status", state: "running" }, // history
      { seq: 2, kind: "text", text: "hello" }, // history
      { seq: 2, kind: "text", text: "dup" }, // duplicate seq → dropped
      { seq: 3, kind: "tool_result", id: "x", content: "ok", is_error: false }, // live
      { seq: 4, kind: "status", state: "idle" },
    ];
    const { cookie, session } = await setupSession(h);
    const res = await h.app.request(`/sessions/${session.id}/events`, {
      headers: { cookie, accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    const datas = [...text.matchAll(/data: (.+)/g)].map((m) =>
      JSON.parse(m[1]!),
    );
    const seqs = datas.map((d) => d.seq);
    expect(seqs).toEqual([1, 2, 3, 4]); // duplicate seq=2 dropped, order preserved
    expect(datas[2]).toMatchObject({ kind: "tool_result", isError: false });

    // Frames must ride the DEFAULT (unnamed) SSE channel: the web reads them via
    // native EventSource.onmessage, which never fires for `event:`-named frames.
    // A per-kind name here would render an empty agent panel (kind lives in data).
    expect(text).not.toMatch(/^event:/m);
  });
});
