import {
  MeSchema,
  OrgSchema,
  ProjectSchema,
  SessionSchema,
  TreeEntrySchema,
  FileContentSchema,
  FileDiffSchema,
  PermissionRuleSchema,
  type Me,
  type Org,
  type Project,
  type Session,
  type TreeEntry,
  type FileContent,
  type FileDiff,
  type PermissionRule,
} from "@carrier/contract";

/**
 * Minimal structural type for the zod schemas we consume from `@carrier/contract`.
 * The web app does not depend on `zod` directly, so we only rely on the runtime
 * `.parse` surface the schemas expose (plus the inferred TS types from contract).
 */
interface Parser<T> {
  parse(input: unknown): T;
}

/**
 * Typed fetch client for the BFF. Same-origin: the Vite dev proxy forwards
 * `/bff` and `/auth` to the BFF, and cookie auth rides along automatically.
 * Every response is validated against the shared contract zod schemas so the
 * frontend never trusts an unvalidated shape.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown by the root loader to trigger a redirect to /login. */
export class UnauthorizedError extends ApiError {
  constructor(body?: unknown) {
    super(401, "Unauthorized", body);
    this.name = "UnauthorizedError";
  }
}

type Json = Record<string, unknown> | unknown[] | undefined;

interface RequestOptions {
  method?: string;
  body?: Json;
  signal?: AbortSignal;
}

async function request<T>(
  path: string,
  schema: Parser<T>,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await fetch(`/bff${path}`, {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    headers: opts.body
      ? { "content-type": "application/json", accept: "application/json" }
      : { accept: "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 401) throw new UnauthorizedError();

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    const message =
      (body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : undefined) ?? `Request failed: ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }

  // Empty body (e.g. 204) — only valid when schema accepts undefined.
  if (res.status === 204) {
    return schema.parse(undefined);
  }

  const data = await res.json();
  return schema.parse(data);
}

/** Build an array parser from an element schema (avoids a direct zod import). */
function arrayOf<T>(element: Parser<T>): Parser<T[]> {
  return {
    parse(input: unknown): T[] {
      if (!Array.isArray(input)) throw new Error("Expected an array response");
      return input.map((item) => element.parse(item));
    },
  };
}

/** Parser that ignores the body (for 2xx with no meaningful payload). */
const VoidSchema: Parser<void> = { parse: () => undefined };

const OrgListSchema = arrayOf(OrgSchema);
const ProjectListSchema = arrayOf(ProjectSchema);
const SessionListSchema = arrayOf(SessionSchema);
const TreeSchema = arrayOf(TreeEntrySchema);
const PermissionListSchema = arrayOf(PermissionRuleSchema);

export interface PromoteResult {
  ok: boolean;
  prUrl?: string | null;
  message?: string;
}

const PromoteResultSchema: Parser<PromoteResult> = {
  parse(input: unknown): PromoteResult {
    const o = (input ?? {}) as Record<string, unknown>;
    return {
      ok: Boolean(o.ok),
      prUrl: typeof o.prUrl === "string" ? o.prUrl : null,
      message: typeof o.message === "string" ? o.message : undefined,
    };
  },
};

export const api = {
  // ── Identity ───────────────────────────────────────────────────────────
  me(signal?: AbortSignal): Promise<Me> {
    return request("/me", MeSchema, { signal });
  },

  logout(): Promise<void> {
    // logout lives under /auth, not /bff — call directly.
    return fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).then(() => undefined);
  },

  // ── Orgs ───────────────────────────────────────────────────────────────
  orgs(signal?: AbortSignal): Promise<Org[]> {
    return request("/orgs", OrgListSchema, { signal });
  },

  // ── Projects ───────────────────────────────────────────────────────────
  projects(orgSlug: string, signal?: AbortSignal): Promise<Project[]> {
    return request(`/orgs/${encodeURIComponent(orgSlug)}/projects`, ProjectListSchema, {
      signal,
    });
  },

  createProject(orgSlug: string, name: string): Promise<Project> {
    return request(`/orgs/${encodeURIComponent(orgSlug)}/projects`, ProjectSchema, {
      method: "POST",
      body: { name },
    });
  },

  project(projectId: string, signal?: AbortSignal): Promise<Project> {
    return request(`/projects/${encodeURIComponent(projectId)}`, ProjectSchema, { signal });
  },

  bindRepo(
    projectId: string,
    binding: { installationId: number; repoFullName: string; defaultBranch?: string },
  ): Promise<Project> {
    return request(`/projects/${encodeURIComponent(projectId)}/bind`, ProjectSchema, {
      method: "POST",
      body: binding,
    });
  },

  unbindRepo(projectId: string): Promise<Project> {
    return request(`/projects/${encodeURIComponent(projectId)}/bind`, ProjectSchema, {
      method: "DELETE",
    });
  },

  // ── Sessions ───────────────────────────────────────────────────────────
  sessions(projectId: string, signal?: AbortSignal): Promise<Session[]> {
    return request(`/projects/${encodeURIComponent(projectId)}/sessions`, SessionListSchema, {
      signal,
    });
  },

  createSession(
    projectId: string,
    opts: { title?: string; planMode?: boolean },
  ): Promise<Session> {
    return request(`/projects/${encodeURIComponent(projectId)}/sessions`, SessionSchema, {
      method: "POST",
      body: opts,
    });
  },

  session(sessionId: string, signal?: AbortSignal): Promise<Session> {
    return request(`/sessions/${encodeURIComponent(sessionId)}`, SessionSchema, { signal });
  },

  // ── Files / tree / diff (session-scoped working copy) ────────────────────
  tree(sessionId: string, path = "", signal?: AbortSignal): Promise<TreeEntry[]> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/sessions/${encodeURIComponent(sessionId)}/tree${q}`, TreeSchema, { signal });
  },

  file(sessionId: string, path: string, signal?: AbortSignal): Promise<FileContent> {
    return request(
      `/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
      FileContentSchema,
      { signal },
    );
  },

  diff(sessionId: string, path: string, signal?: AbortSignal): Promise<FileDiff> {
    return request(
      `/sessions/${encodeURIComponent(sessionId)}/diff?path=${encodeURIComponent(path)}`,
      FileDiffSchema,
      { signal },
    );
  },

  // ── Session control ──────────────────────────────────────────────────────
  sendInput(sessionId: string, text: string, steer = false): Promise<void> {
    return request(`/sessions/${encodeURIComponent(sessionId)}/input`, VoidSchema, {
      method: "POST",
      body: { text, steer },
    });
  },

  interrupt(sessionId: string): Promise<void> {
    return request(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, VoidSchema, {
      method: "POST",
    });
  },

  approve(sessionId: string, reqId: string, allow: boolean): Promise<void> {
    return request(
      `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(reqId)}`,
      VoidSchema,
      { method: "POST", body: { allow } },
    );
  },

  promote(sessionId: string): Promise<PromoteResult> {
    return request(`/sessions/${encodeURIComponent(sessionId)}/promote`, PromoteResultSchema, {
      method: "POST",
    });
  },

  // ── Permissions ──────────────────────────────────────────────────────────
  permissions(projectId: string, signal?: AbortSignal): Promise<PermissionRule[]> {
    return request(
      `/projects/${encodeURIComponent(projectId)}/permissions`,
      PermissionListSchema,
      { signal },
    );
  },
};

/** URL of the session SSE stream (relative; same-origin via the proxy). */
export function eventsUrl(sessionId: string): string {
  return `/bff/sessions/${encodeURIComponent(sessionId)}/events`;
}
