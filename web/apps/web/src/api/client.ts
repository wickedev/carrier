import {
  MeSchema,
  OrgSchema,
  ProjectSchema,
  SessionSchema,
  TreeEntrySchema,
  FileContentSchema,
  FileDiffSchema,
  PermissionRuleSchema,
  UsageSchema,
  type Me,
  type Org,
  type Project,
  type Session,
  type TreeEntry,
  type FileContent,
  type FileDiff,
  type PermissionRule,
  type Usage,
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
    // The BFF returns `pullRequestUrl`; accept `prUrl` too for forward-compat.
    const url =
      typeof o.pullRequestUrl === "string"
        ? o.pullRequestUrl
        : typeof o.prUrl === "string"
          ? o.prUrl
          : null;
    return {
      ok: Boolean(o.ok),
      prUrl: url,
      message: typeof o.message === "string" ? o.message : undefined,
    };
  },
};

// ── Members (org membership management — Req 17/21) ──────────────────────────
export interface Member {
  accountId: string;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  role: "owner" | "admin" | "member";
}

const MemberSchema: Parser<Member> = {
  parse(input: unknown): Member {
    const o = (input ?? {}) as Record<string, unknown>;
    if (typeof o.login !== "string") throw new Error("Invalid member: login");
    const role = o.role;
    if (role !== "owner" && role !== "admin" && role !== "member") {
      throw new Error("Invalid member: role");
    }
    return {
      accountId: typeof o.accountId === "string" ? o.accountId : String(o.accountId ?? ""),
      login: o.login,
      name: typeof o.name === "string" ? o.name : null,
      avatarUrl: typeof o.avatarUrl === "string" ? o.avatarUrl : null,
      role,
    };
  },
};
const MemberListSchema = arrayOf(MemberSchema);

// ── GitHub installations (Req 9/21) ──────────────────────────────────────────
export interface InstallationRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}
export interface Installation {
  installationId: number;
  accountLogin: string;
  repos: InstallationRepo[];
}

const InstallationSchema: Parser<Installation> = {
  parse(input: unknown): Installation {
    const o = (input ?? {}) as Record<string, unknown>;
    if (typeof o.installationId !== "number") {
      throw new Error("Invalid installation: installationId");
    }
    const repos = Array.isArray(o.repos) ? o.repos : [];
    return {
      installationId: o.installationId,
      accountLogin: typeof o.accountLogin === "string" ? o.accountLogin : "",
      repos: repos.map((r) => {
        const rr = (r ?? {}) as Record<string, unknown>;
        return {
          fullName: String(rr.fullName ?? ""),
          defaultBranch: String(rr.defaultBranch ?? "main"),
          private: Boolean(rr.private),
        };
      }),
    };
  },
};
const InstallationListSchema = arrayOf(InstallationSchema);

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

  archiveProject(projectId: string): Promise<void> {
    return request(`/projects/${encodeURIComponent(projectId)}/archive`, VoidSchema, {
      method: "POST",
    });
  },

  // ── Org members (Req 17/21) ─────────────────────────────────────────────
  members(orgSlug: string, signal?: AbortSignal): Promise<Member[]> {
    return request(`/orgs/${encodeURIComponent(orgSlug)}/members`, MemberListSchema, {
      signal,
    });
  },

  addMember(
    orgSlug: string,
    member: { login: string; role: "owner" | "admin" | "member" },
  ): Promise<Member> {
    return request(`/orgs/${encodeURIComponent(orgSlug)}/members`, MemberSchema, {
      method: "POST",
      body: member,
    });
  },

  removeMember(orgSlug: string, accountId: string): Promise<void> {
    return request(
      `/orgs/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(accountId)}`,
      VoidSchema,
      { method: "DELETE" },
    );
  },

  // ── GitHub installations (Req 9/21) — scoped to the caller's org ─────────
  installations(org: string, signal?: AbortSignal): Promise<Installation[]> {
    return request(
      `/github/orgs/${encodeURIComponent(org)}/installations`,
      InstallationListSchema,
      { signal },
    );
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

  // ── Usage / cost (Req 16/20) ─────────────────────────────────────────────
  sessionUsage(sessionId: string, signal?: AbortSignal): Promise<Usage> {
    return request(`/sessions/${encodeURIComponent(sessionId)}/usage`, UsageSchema, {
      signal,
    });
  },

  projectUsage(projectId: string, signal?: AbortSignal): Promise<Usage> {
    return request(`/projects/${encodeURIComponent(projectId)}/usage`, UsageSchema, {
      signal,
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

  addPermission(
    projectId: string,
    rule: { action: string; pattern: string; effect: "allow" | "deny" | "ask" },
  ): Promise<PermissionRule> {
    return request(
      `/projects/${encodeURIComponent(projectId)}/permissions`,
      PermissionRuleSchema,
      { method: "POST", body: rule },
    );
  },

  deletePermission(projectId: string, ruleId: string): Promise<void> {
    return request(
      `/projects/${encodeURIComponent(projectId)}/permissions/${encodeURIComponent(ruleId)}`,
      VoidSchema,
      { method: "DELETE" },
    );
  },
};

/** URL of the session SSE stream (relative; same-origin via the proxy). */
export function eventsUrl(sessionId: string): string {
  return `/bff/sessions/${encodeURIComponent(sessionId)}/events`;
}
