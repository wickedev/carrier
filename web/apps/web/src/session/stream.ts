import { create, type StoreApi } from "zustand";
import {
  SessionEventSchema,
  type SessionEvent,
  type SessionStatus,
} from "@carrier/contract";

/**
 * SessionStream — the live event store for one Carrier session.
 *
 * Design
 * ------
 * The store is fed by an `EventSource` to `/bff/sessions/:id/events`. The BFF
 * replays history then streams live events, so on reconnect we receive an
 * overlapping prefix. Correctness rests on the reducer, which is deliberately
 * separated from transport so it can be unit-tested by injecting events:
 *
 *  - **Ordering:** events carry a monotonic `seq`. We keep `events` sorted by
 *    `seq` and insert each new event at its correct position (binary search),
 *    so out-of-order delivery still yields an ordered log.
 *  - **Dedupe:** a `Set<number>` of seen `seq` values drops replays. (Carrier
 *    history + live can overlap; the BFF history replay relies on this.)
 *  - **Status derivation:** the latest `status` event wins; `error` implies a
 *    terminated-ish degraded state is surfaced separately via `lastError`.
 *  - **Approval correlation:** `approval_request` events accumulate into a
 *    `pendingApprovals` map keyed by `reqId`; resolving an approval (the user
 *    decided) removes it. This is what the ApprovalCard binds to.
 *
 * Transport (connect/disconnect/backoff) is layered on top and is injectable
 * for tests via the `eventSourceFactory` option.
 */

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface PendingApproval {
  reqId: string;
  tool: string;
  resource: string;
  reason: string;
  seq: number;
}

export interface SessionStreamState {
  sessionId: string | null;
  /** Ordered (by seq), seq-deduped event log. */
  events: SessionEvent[];
  /** Seen seq values, for O(1) dedupe. */
  seen: Set<number>;
  /** Derived run status from the latest `status` event. */
  status: SessionStatus;
  /** Pending HITL approvals keyed by reqId, in arrival order. */
  pendingApprovals: PendingApproval[];
  /** Most recent error event message, if any (cleared on reconnect success). */
  lastError: string | null;
  connection: ConnectionState;

  // actions
  ingest: (raw: unknown) => void;
  ingestEvent: (event: SessionEvent) => void;
  resolveApproval: (reqId: string) => void;
  reset: (sessionId: string | null) => void;
  setConnection: (c: ConnectionState) => void;
}

/** Binary-search insert index for `seq` in an ascending-by-seq list. */
function insertIndex(events: SessionEvent[], seq: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const item = events[mid];
    if (item && item.seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Pure reducer step. Returns the next partial state (or null when the event is
 * a duplicate and nothing changes). Exported for direct unit testing.
 */
export function reduce(
  state: Pick<SessionStreamState, "events" | "seen" | "status" | "pendingApprovals" | "lastError">,
  event: SessionEvent,
): Pick<SessionStreamState, "events" | "seen" | "status" | "pendingApprovals" | "lastError"> | null {
  if (state.seen.has(event.seq)) return null;

  const seen = new Set(state.seen);
  seen.add(event.seq);

  const events = state.events.slice();
  events.splice(insertIndex(events, event.seq), 0, event);

  let status = state.status;
  let pendingApprovals = state.pendingApprovals;
  let lastError = state.lastError;

  switch (event.kind) {
    case "status":
      status = event.state;
      break;
    case "approval_request":
      if (!pendingApprovals.some((a) => a.reqId === event.reqId)) {
        pendingApprovals = [
          ...pendingApprovals,
          {
            reqId: event.reqId,
            tool: event.tool,
            resource: event.resource,
            reason: event.reason,
            seq: event.seq,
          },
        ];
      }
      break;
    case "error":
      lastError = event.message;
      break;
    default:
      break;
  }

  return { events, seen, status, pendingApprovals, lastError };
}

const INITIAL = {
  sessionId: null as string | null,
  events: [] as SessionEvent[],
  seen: new Set<number>(),
  status: "idle" as SessionStatus,
  pendingApprovals: [] as PendingApproval[],
  lastError: null as string | null,
  connection: "idle" as ConnectionState,
};

export type SessionStreamStore = StoreApi<SessionStreamState>;

export const createSessionStreamStore = (): SessionStreamStore =>
  create<SessionStreamState>((set, get) => ({
    ...INITIAL,
    seen: new Set<number>(),
    events: [],
    pendingApprovals: [],

    ingest(raw) {
      const parsed = SessionEventSchema.safeParse(raw);
      if (!parsed.success) {
        // Drop malformed frames rather than poisoning the log.
        return;
      }
      get().ingestEvent(parsed.data);
    },

    ingestEvent(event) {
      const next = reduce(get(), event);
      if (next) set(next);
    },

    resolveApproval(reqId) {
      set((s) => ({
        pendingApprovals: s.pendingApprovals.filter((a) => a.reqId !== reqId),
      }));
    },

    reset(sessionId) {
      set({
        sessionId,
        events: [],
        seen: new Set<number>(),
        status: "idle",
        pendingApprovals: [],
        lastError: null,
        connection: "idle",
      });
    },

    setConnection(connection) {
      set({ connection });
      if (connection === "open") set({ lastError: null });
    },
  }));

/** The app-wide singleton store (one session viewed at a time in the IDE). */
export const useSessionStream = createSessionStreamStore();

// ── Transport: EventSource with reconnect/backoff ────────────────────────────

export interface EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: string }) => unknown) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const defaultFactory: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

export interface ConnectOptions {
  store?: SessionStreamStore;
  factory?: EventSourceFactory;
  /** Backoff schedule (ms) for reconnect attempts; last value repeats. */
  backoff?: number[];
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * Open a managed SSE connection feeding the store. Returns a disposer that
 * closes the connection and cancels any pending reconnect. Reconnect relies on
 * BFF history replay + seq dedupe to recover missed events.
 */
export function connectSessionStream(
  url: string,
  opts: ConnectOptions = {},
): () => void {
  const store = opts.store ?? useSessionStream;
  const factory = opts.factory ?? defaultFactory;
  const backoff = opts.backoff ?? [500, 1000, 2000, 4000, 8000];
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;

  let es: EventSourceLike | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    store.getState().setConnection(attempt === 0 ? "connecting" : "reconnecting");
    const source = factory(url);
    es = source;

    source.onopen = () => {
      attempt = 0;
      store.getState().setConnection("open");
    };
    source.onmessage = (ev) => {
      try {
        store.getState().ingest(JSON.parse(ev.data));
      } catch {
        /* ignore non-JSON keepalives */
      }
    };
    source.onerror = () => {
      source.close();
      if (es === source) es = null;
      if (disposed) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 1000;
      attempt += 1;
      store.getState().setConnection("reconnecting");
      timer = setT(open, delay);
    };
  };

  open();

  return () => {
    disposed = true;
    if (timer) clearT(timer);
    if (es) es.close();
    store.getState().setConnection("closed");
  };
}
