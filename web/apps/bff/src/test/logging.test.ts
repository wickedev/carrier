import { describe, it, expect } from "vitest";
import { makeHarness } from "./harness.js";
import { redactPath } from "../logging.js";

describe("structured request logging + secret redaction (task 24)", () => {
  it("redacts sensitive query params in paths", () => {
    expect(redactPath("/auth/github/callback?code=abc&state=xyz")).toBe(
      "/auth/github/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D",
    );
    expect(redactPath("/sessions/1/tree?path=src")).toBe(
      "/sessions/1/tree?path=src",
    );
    expect(redactPath("/health")).toBe("/health");
  });

  it("logs one structured line per request with method/path/status/duration/requestId", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/health");
    expect(res.status).toBe(200);
    // requestId is echoed back to the caller.
    expect(res.headers.get("x-request-id")).toBeTruthy();

    expect(h.logLines.length).toBeGreaterThanOrEqual(1);
    const line = h.logLines.at(-1)!;
    expect(line).toMatchObject({
      msg: "request",
      method: "GET",
      path: "/health",
      status: 200,
    });
    expect(typeof line.durationMs).toBe("number");
    expect(line.requestId).toBeTruthy();
  });

  it("never logs tokens or cookies (secrets stay out of the log line)", async () => {
    const h = await makeHarness();
    const { accountId } = await h.seedAccount("dev");
    const cookie = await h.cookieFor(accountId);

    await h.app.request("/me", {
      headers: { cookie, authorization: "Bearer super-secret-token" },
    });

    const serialized = JSON.stringify(h.logLines);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("carrier_session");
    // The session cookie value must not appear in any log line.
    const cookieValue = cookie.split("=")[1] ?? "";
    expect(serialized).not.toContain(cookieValue);
  });

  it("redacts the OAuth code/state when the callback path is logged", async () => {
    const h = await makeHarness();
    // Hit the callback (it will 403 on state mismatch) — the path is still logged.
    await h.app.request("/auth/github/callback?code=topsecret&state=alsosecret");
    const callbackLine = h.logLines.find((l) =>
      l.path.startsWith("/auth/github/callback"),
    );
    expect(callbackLine).toBeTruthy();
    expect(callbackLine!.path).not.toContain("topsecret");
    expect(callbackLine!.path).not.toContain("alsosecret");
  });
});
