// @carrier/carrier-client — a thin typed client for the Carrier runtime's
// HTTP + SSE API (POST /v1/sessions, POST /v1/sessions/:id/input,
// POST /v1/sessions/:id/interrupt, GET /v1/sessions/:id/events). The BFF is the
// only caller; it maps raw Carrier events to the @carrier/contract SessionEvent.

export interface CarrierClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface SkillSpec {
  name: string;
  description: string;
  body: string;
  agent?: string;
  allowedTools?: string[];
}
export interface SubagentSpec {
  name: string;
  description: string;
  prompt: string;
  model?: string;
}
export interface HookSpec {
  name: string;
  event: string;
  command: string;
  matcher?: string;
}
export interface PermissionSpec {
  action: string;
  pattern: string;
  effect: "allow" | "deny" | "ask";
}
export interface PluginRef {
  name: string;
  version: string;
  manifestDigest: string;
  wasmDigest: string;
  grantedCaps: string[];
  allowPermissions: boolean;
}

export interface CreateSessionInput {
  /** Working directory for the session sandbox — the per-session working copy. */
  cwd?: string;
  system?: string;
  planMode?: boolean;
  /** AGENTS.md-like instructions prepended to the session's durable memory. */
  context?: string;
  model?: string;
  effort?: string;
  maxSteps?: number;
  contextBudget?: number;
  env?: Record<string, string>;
  mcpServers?: McpServerSpec[];
  skills?: SkillSpec[];
  subagents?: SubagentSpec[];
  hooks?: HookSpec[];
  permissions?: PermissionSpec[];
  plugins?: PluginRef[];
}

/** Raw event as emitted by the Carrier SSE endpoint (snake_case wire shape). */
export interface RawCarrierEvent {
  seq: number;
  kind: string;
  text?: string;
  name?: string;
  id?: string;
  content?: string;
  is_error?: boolean;
  path?: string;
  status?: string;
  state?: string;
  message?: string;
  req_id?: string;
  tool?: string;
  resource?: string;
  reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  title?: string;
}

export class CarrierError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CarrierError";
  }
}

export class CarrierClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CarrierClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async createSession(input: CreateSessionInput = {}): Promise<string> {
    // Snake-case the wire body to match the Carrier runtime's JSON contract.
    const body: Record<string, unknown> = {
      cwd: input.cwd,
      system: input.system,
      plan_mode: input.planMode,
      context: input.context,
      model: input.model,
      effort: input.effort,
      max_steps: input.maxSteps,
      context_budget: input.contextBudget,
      env: input.env,
      mcp_servers: input.mcpServers?.map((m) => ({
        name: m.name,
        command: m.command,
        args: m.args,
        env: m.env,
      })),
      skills: input.skills?.map((s) => ({
        name: s.name,
        description: s.description,
        body: s.body,
        agent: s.agent,
        allowed_tools: s.allowedTools,
      })),
      subagents: input.subagents?.map((a) => ({
        name: a.name,
        description: a.description,
        prompt: a.prompt,
        model: a.model,
      })),
      hooks: input.hooks?.map((h) => ({
        name: h.name,
        event: h.event,
        command: h.command,
        matcher: h.matcher,
      })),
      permissions: input.permissions?.map((p) => ({
        action: p.action,
        pattern: p.pattern,
        effect: p.effect,
      })),
      plugins: input.plugins?.map((p) => ({
        name: p.name,
        version: p.version,
        manifest_digest: p.manifestDigest,
        wasm_digest: p.wasmDigest,
        granted_caps: p.grantedCaps,
        allow_permissions: p.allowPermissions,
      })),
    };
    const res = await this.fetchImpl(`${this.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new CarrierError(`createSession failed`, res.status);
    const respBody = (await res.json()) as { session_id: string };
    return respBody.session_id;
  }

  async sendInput(
    sessionId: string,
    text: string,
    steer = false,
    overrides: { model?: string; effort?: string; planMode?: boolean } = {},
  ): Promise<void> {
    // Per-turn overrides are optional: omit absent ones so the runtime falls
    // back to the session defaults (snake_case `plan_mode` on the wire).
    const body: Record<string, unknown> = { text, steer };
    if (overrides.model) body.model = overrides.model;
    if (overrides.effort) body.effort = overrides.effort;
    if (overrides.planMode !== undefined) body.plan_mode = overrides.planMode;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/input`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new CarrierError(`sendInput failed`, res.status);
  }

  async interrupt(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/interrupt`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) throw new CarrierError(`interrupt failed`, res.status);
  }

  /** Delivers a human approve/deny decision for a pending Ask-effect tool,
   *  correlated by the approval request ID. */
  async resolveApproval(sessionId: string, reqId: string, allow: boolean): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/sessions/${sessionId}/approvals/${reqId}`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ allow }),
      },
    );
    if (!res.ok) throw new CarrierError(`resolveApproval failed`, res.status);
  }

  /** Streams normalized raw Carrier events; closes when the upstream ends or the
   *  signal aborts. */
  async *streamEvents(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<RawCarrierEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/events`, {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) throw new CarrierError(`stream failed`, res.status);
    yield* parseSSE(res.body);
  }
}

/** Parses an SSE byte stream into the JSON `data:` payloads. */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawCarrierEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) {
            try {
              yield JSON.parse(payload) as RawCarrierEvent;
            } catch {
              // ignore malformed frame
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
