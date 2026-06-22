import type { Page, Route } from "@playwright/test";
import type {
  Me,
  Org,
  Project,
  Session,
  TreeEntry,
  FileContent,
  FileDiff,
  SessionEvent,
} from "@carrier/contract";

/**
 * Canned BFF/auth fixtures + route-mocking helpers.
 *
 * The shapes here mirror `@carrier/contract` exactly (the web app validates
 * every response against the shared zod schemas, so a wrong shape would fail
 * loudly at runtime). `installMocks(page, opts)` registers `page.route(...)`
 * handlers for the whole flow; toggles let individual specs vary behaviour
 * (e.g. an unauthenticated `/me`, or which SSE frames the stream emits).
 */

// ── Identity & orgs ──────────────────────────────────────────────────────────

export const ORG: Org = {
  id: "org_1",
  kind: "org",
  slug: "acme",
  name: "Acme Inc",
  role: "owner",
};

export const ME: Me = {
  account: {
    id: "acct_1",
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
  },
  orgs: [ORG],
};

// ── Projects ──────────────────────────────────────────────────────────────────

export const PROJECT: Project = {
  id: "proj_1",
  orgId: ORG.id,
  slug: "web-client",
  name: "Web Client",
  archived: false,
  repo: {
    repoFullName: "acme/web-client",
    defaultBranch: "main",
    installationId: 42,
  },
  createdAt: "2026-06-01T00:00:00.000Z",
};

export const PROJECTS: Project[] = [PROJECT];

// ── Sessions ──────────────────────────────────────────────────────────────────

export const SESSION: Session = {
  id: "sess_1",
  projectId: PROJECT.id,
  title: "Implement login flow",
  status: "running",
  planMode: false,
  workingCopy: {
    branch: "carrier/sess_1",
    dirty: true,
    ahead: 1,
    behind: 0,
  },
  createdAt: "2026-06-10T12:00:00.000Z",
  archived: false,
};

export const SESSIONS: Session[] = [SESSION];

// ── Tree / file / diff (session-scoped working copy) ─────────────────────────

export const TREE: TreeEntry[] = [
  { path: "src", name: "src", type: "dir" },
  { path: "README.md", name: "README.md", type: "file", git: "M" },
  { path: "package.json", name: "package.json", type: "file", git: "clean" },
];

export const TREE_SRC: TreeEntry[] = [
  { path: "src/index.ts", name: "index.ts", type: "file", git: "A" },
];

export const FILE: FileContent = {
  path: "README.md",
  content: "# Web Client\n\nHello from the mocked working copy.\n",
  truncated: false,
  binary: false,
};

export const DIFF: FileDiff = {
  path: "README.md",
  before: "# Web Client\n",
  after: "# Web Client\n\nHello from the mocked working copy.\n",
};

// ── SSE event stream ──────────────────────────────────────────────────────────

/** A small ordered log of normal activity frames. */
export const STREAM_EVENTS: SessionEvent[] = [
  { seq: 1, kind: "status", state: "running" },
  { seq: 2, kind: "text", text: "Starting work on the login flow." },
  { seq: 3, kind: "reasoning", text: "I should inspect the existing routes first." },
  {
    seq: 4,
    kind: "tool_call",
    id: "call_1",
    name: "read_file",
    input: { path: "src/routes/login.tsx" },
  },
  {
    seq: 5,
    kind: "tool_result",
    id: "call_1",
    content: "export function LoginPage() { ... }",
    isError: false,
  },
  { seq: 6, kind: "file_changed", path: "README.md", status: "M" },
];

/** An `approval_request` frame used by the HITL spec. */
export const APPROVAL_EVENT: SessionEvent = {
  seq: 7,
  kind: "approval_request",
  reqId: "req_1",
  tool: "bash",
  resource: "rm -rf build",
  reason: "The agent wants to remove the build directory.",
};

/**
 * Serialize SessionEvents into a `text/event-stream` body. Each frame is one
 * `data: {...}` line (the app's EventSource `onmessage` does `JSON.parse`).
 * A trailing retry/keepalive comment keeps the stream well-formed.
 */
export function sseBody(events: SessionEvent[]): string {
  const frames = events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");
  return frames + ": keepalive\n\n";
}

// ── Route installation ────────────────────────────────────────────────────────

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

export interface MockOptions {
  /** When false, `/bff/me` responds 401 (drives the auth-guard redirect). */
  authenticated?: boolean;
  /** Events delivered by the SSE stream for `/bff/sessions/:id/events`. */
  streamEvents?: SessionEvent[];
}

/**
 * Register all BFF + auth route handlers for a page. Specs call this once at
 * the top; nothing escapes to a real network. Order matters — more specific
 * patterns are registered before the catch-all so Playwright (last-registered
 * wins) still routes correctly, so we register the catch-all *first*.
 */
export async function installMocks(page: Page, opts: MockOptions = {}): Promise<void> {
  const authenticated = opts.authenticated ?? true;
  const streamEvents = opts.streamEvents ?? STREAM_EVENTS;

  // Catch-all for any unforeseen BFF call → 404 JSON (registered first so the
  // specific handlers below, registered later, take precedence).
  await page.route("**/bff/**", (route) => json(route, { message: "not mocked" }, 404));

  // ── auth ──
  await page.route("**/auth/github", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html>oauth stub</html>" }),
  );
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 204, body: "" }));

  // ── identity ──
  await page.route("**/bff/me", (route) => {
    if (!authenticated) return json(route, { message: "Unauthorized" }, 401);
    return json(route, ME);
  });

  await page.route("**/bff/orgs", (route) => json(route, [ORG]));

  // ── projects ──
  await page.route("**/bff/orgs/*/projects", (route) => json(route, PROJECTS));
  await page.route("**/bff/projects/proj_1", (route) => json(route, PROJECT));

  // ── sessions ──
  await page.route("**/bff/projects/proj_1/sessions", (route) => json(route, SESSIONS));
  await page.route("**/bff/sessions/sess_1", (route) => json(route, SESSION));

  // ── files / tree / diff (query strings on path are matched by glob) ──
  await page.route("**/bff/sessions/sess_1/tree**", (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    return json(route, path === "src" ? TREE_SRC : TREE);
  });
  await page.route("**/bff/sessions/sess_1/file**", (route) => json(route, FILE));
  await page.route("**/bff/sessions/sess_1/diff**", (route) => json(route, DIFF));

  // ── SSE stream (EventSource GET) ──
  await page.route("**/bff/sessions/sess_1/events", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: sseBody(streamEvents),
    }),
  );

  // ── session control (POST endpoints) ──
  await page.route("**/bff/sessions/sess_1/input", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/bff/sessions/sess_1/interrupt", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/bff/sessions/sess_1/approvals/**", (route) => route.fulfill({ status: 204, body: "" }));
}
