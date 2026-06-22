import { describe, it, expect, vi } from "vitest";
import type { Me } from "@carrier/contract";
import { makeRootLoader, makeIndexLoader } from "./loaders";
import { UnauthorizedError } from "../api/client";

const me: Me = {
  account: { id: "1", login: "octocat", name: "Octo", avatarUrl: "https://x/y.png" },
  orgs: [{ id: "o1", kind: "personal", slug: "octocat", name: "Octo", role: "owner" }],
};

const args = (url: string) =>
  ({
    request: new Request(url),
    params: {},
    context: {},
  }) as unknown as Parameters<ReturnType<typeof makeRootLoader>>[0];

describe("rootLoader (auth guard)", () => {
  it("returns Me when authenticated", async () => {
    const loader = makeRootLoader({ api: { me: vi.fn().mockResolvedValue(me) } });
    const result = await loader(args("http://localhost/octocat"));
    expect(result).toEqual(me);
  });

  it("redirects to /login preserving the intended destination on 401", async () => {
    const loader = makeRootLoader({
      api: { me: vi.fn().mockRejectedValue(new UnauthorizedError()) },
    });
    let thrown: unknown;
    try {
      await loader(args("http://localhost/octocat/proj-1/s/sess-1?tab=diff"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    const location = res.headers.get("Location")!;
    expect(location).toContain("/login?next=");
    expect(decodeURIComponent(location)).toContain("/octocat/proj-1/s/sess-1?tab=diff");
  });

  it("rethrows non-auth errors (handled by the route errorElement)", async () => {
    const boom = new Error("network down");
    const loader = makeRootLoader({ api: { me: vi.fn().mockRejectedValue(boom) } });
    await expect(loader(args("http://localhost/"))).rejects.toBe(boom);
  });
});

describe("indexLoader", () => {
  it("redirects to the first org when authenticated", async () => {
    const loader = makeIndexLoader({ api: { me: vi.fn().mockResolvedValue(me) } });
    let thrown: unknown;
    try {
      await loader(args("http://localhost/"));
    } catch (e) {
      thrown = e;
    }
    const res = thrown as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("Location")).toBe("/octocat");
  });

  it("redirects to /login when unauthenticated", async () => {
    const loader = makeIndexLoader({
      api: { me: vi.fn().mockRejectedValue(new UnauthorizedError()) },
    });
    let thrown: unknown;
    try {
      await loader(args("http://localhost/"));
    } catch (e) {
      thrown = e;
    }
    const res = thrown as Response;
    expect(res.headers.get("Location")).toBe("/login");
  });
});
