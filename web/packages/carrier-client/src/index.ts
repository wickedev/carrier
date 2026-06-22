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

export interface CreateSessionInput {
  /** Working directory for the session sandbox — the per-session working copy. */
  cwd?: string;
  system?: string;
  planMode?: boolean;
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
    const res = await this.fetchImpl(`${this.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ cwd: input.cwd, system: input.system, plan_mode: input.planMode }),
    });
    if (!res.ok) throw new CarrierError(`createSession failed`, res.status);
    const body = (await res.json()) as { session_id: string };
    return body.session_id;
  }

  async sendInput(sessionId: string, text: string, steer = false): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/input`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ text, steer }),
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
