import { describe, it, expect } from "vitest";
import type { SessionEvent, SessionStatus } from "@carrier/contract";
import { createSessionStreamStore, reduce } from "./stream";
import type { PendingApproval } from "./stream";

interface ReducerState {
  events: SessionEvent[];
  seen: Set<number>;
  status: SessionStatus;
  pendingApprovals: PendingApproval[];
  lastError: string | null;
}

const ev = {
  text: (seq: number, text = "hi"): SessionEvent => ({ seq, kind: "text", text }),
  status: (seq: number, state: "running" | "idle" | "terminated"): SessionEvent => ({
    seq,
    kind: "status",
    state,
  }),
  approval: (seq: number, reqId: string): SessionEvent => ({
    seq,
    kind: "approval_request",
    reqId,
    tool: "bash",
    resource: "rm -rf /",
    reason: "dangerous",
  }),
  fileChanged: (seq: number, path: string): SessionEvent => ({
    seq,
    kind: "file_changed",
    path,
    status: "M",
  }),
  error: (seq: number, message: string): SessionEvent => ({ seq, kind: "error", message }),
};

const emptyState = (): ReducerState => ({
  events: [],
  seen: new Set<number>(),
  status: "idle",
  pendingApprovals: [],
  lastError: null,
});

describe("reduce (pure reducer)", () => {
  it("appends events in seq order even when delivered out of order", () => {
    let s = emptyState();
    for (const e of [ev.text(3, "c"), ev.text(1, "a"), ev.text(2, "b")]) {
      s = reduce(s, e)!;
    }
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.events.map((e) => (e.kind === "text" ? e.text : ""))).toEqual(["a", "b", "c"]);
  });

  it("dedupes events by seq (history replay overlap)", () => {
    let s = emptyState();
    s = reduce(s, ev.text(1))!;
    s = reduce(s, ev.text(2))!;
    // replay overlap — seq 1 and 2 seen again
    const r1 = reduce(s, ev.text(1));
    const r2 = reduce(s, ev.text(2));
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(s.events).toHaveLength(2);
  });

  it("derives run status from the latest status event", () => {
    let s = emptyState();
    s = reduce(s, ev.status(1, "running"))!;
    expect(s.status).toBe("running");
    s = reduce(s, ev.status(2, "idle"))!;
    expect(s.status).toBe("idle");
    s = reduce(s, ev.status(3, "terminated"))!;
    expect(s.status).toBe("terminated");
  });

  it("accumulates pending approvals keyed by reqId without duplicates", () => {
    let s = emptyState();
    s = reduce(s, ev.approval(1, "req-a"))!;
    s = reduce(s, ev.approval(2, "req-b"))!;
    expect(s.pendingApprovals.map((a) => a.reqId)).toEqual(["req-a", "req-b"]);
    // a re-seen approval (different seq, same reqId) does not duplicate
    s = reduce(s, ev.approval(3, "req-a"))!;
    expect(s.pendingApprovals.filter((a) => a.reqId === "req-a")).toHaveLength(1);
  });

  it("records the latest error message in lastError", () => {
    let s = emptyState();
    s = reduce(s, ev.error(1, "boom"))!;
    expect(s.lastError).toBe("boom");
  });
});

describe("SessionStream store", () => {
  it("ingests validated frames and ignores malformed ones", () => {
    const store = createSessionStreamStore();
    store.getState().ingest({ seq: 1, kind: "text", text: "hello" });
    store.getState().ingest({ seq: 2, kind: "bogus" }); // invalid → dropped
    store.getState().ingest({ seq: 3, kind: "status", state: "running" });
    const s = store.getState();
    expect(s.events.map((e) => e.seq)).toEqual([1, 3]);
    expect(s.status).toBe("running");
  });

  it("correlates and resolves approvals", () => {
    const store = createSessionStreamStore();
    store.getState().ingestEvent(ev.approval(1, "req-x"));
    store.getState().ingestEvent(ev.approval(2, "req-y"));
    expect(store.getState().pendingApprovals).toHaveLength(2);
    store.getState().resolveApproval("req-x");
    expect(store.getState().pendingApprovals.map((a) => a.reqId)).toEqual(["req-y"]);
  });

  it("reset clears events, seen, status and approvals", () => {
    const store = createSessionStreamStore();
    store.getState().ingestEvent(ev.text(1));
    store.getState().ingestEvent(ev.approval(2, "r"));
    store.getState().reset("session-2");
    const s = store.getState();
    expect(s.sessionId).toBe("session-2");
    expect(s.events).toHaveLength(0);
    expect(s.pendingApprovals).toHaveLength(0);
    expect(s.status).toBe("idle");
    // dedupe set was reset — seq 1 can be ingested again
    store.getState().ingestEvent(ev.text(1));
    expect(store.getState().events).toHaveLength(1);
  });

  it("tracks connection state and clears lastError on open", () => {
    const store = createSessionStreamStore();
    store.getState().ingestEvent(ev.error(1, "dropped"));
    expect(store.getState().lastError).toBe("dropped");
    store.getState().setConnection("open");
    expect(store.getState().connection).toBe("open");
    expect(store.getState().lastError).toBeNull();
  });
});
