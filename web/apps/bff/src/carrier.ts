// Carrier brokering: a factory for the CarrierClient and an event normalizer
// that maps the raw snake_case Carrier wire events to the camelCase contract
// SessionEvent DTO.

import { CarrierClient, type RawCarrierEvent } from "@carrier/carrier-client";
import {
  type SessionEvent,
  SessionEventSchema,
  type GitStatus,
  type SessionStatus,
} from "@carrier/contract";
import type { Config } from "./config.js";

export function createCarrierClient(
  cfg: Config,
  fetchImpl?: typeof fetch,
): CarrierClient {
  return new CarrierClient({
    baseUrl: cfg.carrierBaseUrl,
    token: cfg.carrierToken,
    fetchImpl,
  });
}

const GIT_STATUSES: ReadonlySet<string> = new Set(["A", "M", "D", "U", "clean"]);
const SESSION_STATES: ReadonlySet<string> = new Set([
  "idle",
  "running",
  "terminated",
]);

/**
 * normalizeEvent maps a raw Carrier event to a contract SessionEvent. Returns
 * null for unknown/unmappable kinds so the relay can skip them rather than
 * crash the stream. The result is validated against the contract schema.
 */
export function normalizeEvent(raw: RawCarrierEvent): SessionEvent | null {
  const seq = raw.seq;
  let candidate: unknown;

  switch (raw.kind) {
    case "text":
    case "reasoning":
      candidate = { seq, kind: raw.kind, text: raw.text ?? "" };
      break;
    case "tool_call":
      candidate = {
        seq,
        kind: "tool_call",
        id: raw.id ?? "",
        name: raw.name ?? "",
        input: parseMaybeJson(raw.text),
      };
      break;
    case "tool_result":
      candidate = {
        seq,
        kind: "tool_result",
        id: raw.id ?? "",
        content: raw.content ?? "",
        isError: raw.is_error ?? false,
      };
      break;
    case "file_changed":
      candidate = {
        seq,
        kind: "file_changed",
        path: raw.path ?? "",
        status: coerceGitStatus(raw.status),
      };
      break;
    case "approval_request":
      candidate = {
        seq,
        kind: "approval_request",
        reqId: raw.req_id ?? "",
        tool: raw.tool ?? "",
        resource: raw.resource ?? "",
        reason: raw.reason ?? "",
      };
      break;
    case "status":
      candidate = {
        seq,
        kind: "status",
        state: coerceSessionState(raw.state),
      };
      break;
    case "error":
      candidate = { seq, kind: "error", message: raw.message ?? "" };
      break;
    default:
      return null;
  }

  const parsed = SessionEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseMaybeJson(text: string | undefined): unknown {
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function coerceGitStatus(s: string | undefined): GitStatus {
  return s !== undefined && GIT_STATUSES.has(s) ? (s as GitStatus) : "M";
}

function coerceSessionState(s: string | undefined): SessionStatus {
  return s !== undefined && SESSION_STATES.has(s)
    ? (s as SessionStatus)
    : "running";
}
