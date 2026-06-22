import { describe, expect, it } from "vitest";
import {
  MeSchema,
  ProjectSchema,
  SessionEventSchema,
  SessionSchema,
} from "./index";

describe("contract schemas", () => {
  it("parses a tool_call session event", () => {
    const ev = SessionEventSchema.parse({
      seq: 3,
      kind: "tool_call",
      id: "t1",
      name: "bash",
      input: { command: "ls" },
    });
    expect(ev.kind).toBe("tool_call");
  });

  it("parses an approval_request event", () => {
    const ev = SessionEventSchema.parse({
      seq: 9,
      kind: "approval_request",
      reqId: "req-1",
      tool: "bash",
      resource: "rm -rf /",
      reason: "destructive",
    });
    if (ev.kind !== "approval_request") throw new Error("wrong kind");
    expect(ev.reqId).toBe("req-1");
  });

  it("rejects an unknown event kind", () => {
    expect(() => SessionEventSchema.parse({ seq: 1, kind: "nope" })).toThrow();
  });

  it("parses a project with a null repo binding", () => {
    const p = ProjectSchema.parse({
      id: "p1",
      orgId: "o1",
      slug: "demo",
      name: "Demo",
      archived: false,
      repo: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(p.repo).toBeNull();
  });

  it("parses a session and Me", () => {
    SessionSchema.parse({
      id: "s1",
      projectId: "p1",
      title: "work",
      status: "running",
      planMode: false,
      workingCopy: { branch: "carrier/s1", dirty: true, ahead: 1, behind: 0 },
      createdAt: "2026-01-01T00:00:00Z",
      archived: false,
    });
    MeSchema.parse({
      account: { id: "a1", login: "octo", name: null, avatarUrl: "https://x/y.png" },
      orgs: [{ id: "o1", kind: "personal", slug: "octo", name: "octo", role: "owner" }],
    });
  });
});
