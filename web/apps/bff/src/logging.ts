// Structured request-logging middleware (task 24 — observability).
//
// Emits one JSON line per request with method, path, status, duration (ms), and
// a per-request requestId. Secrets are redacted: Authorization / Cookie request
// headers and Set-Cookie response headers are never logged, the path's query
// string is stripped of sensitive params (code/state/token/secret), and a
// requestId is propagated back to the client via the `x-request-id` header.

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context.js";

export interface LogLine {
  level: "info" | "error";
  msg: "request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

const SENSITIVE_QUERY_KEYS = new Set([
  "code",
  "state",
  "token",
  "secret",
  "access_token",
  "client_secret",
]);

/** Strip the query string of any sensitive params, redacting their values. */
export function redactPath(rawPath: string): string {
  const qIdx = rawPath.indexOf("?");
  if (qIdx < 0) return rawPath;
  const path = rawPath.slice(0, qIdx);
  const params = new URLSearchParams(rawPath.slice(qIdx + 1));
  for (const key of params.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, "[REDACTED]");
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * requestLogger logs a single structured line per request. A `sink` can be
 * injected for tests; it defaults to console.log/console.error. Secrets in
 * headers and query params are never emitted.
 */
export function requestLogger(
  sink: (line: LogLine) => void = defaultSink,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    c.header("x-request-id", requestId);
    const start = Date.now();
    try {
      await next();
    } finally {
      const line: LogLine = {
        level: c.res.status >= 500 ? "error" : "info",
        msg: "request",
        requestId,
        method: c.req.method,
        // c.req.path excludes the query string; redact the full URL's query too.
        path: redactPath(rawPathFrom(c.req.url, c.req.path)),
        status: c.res.status,
        durationMs: Date.now() - start,
      };
      sink(line);
    }
  };
}

function rawPathFrom(url: string, fallbackPath: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return fallbackPath;
  }
}

function defaultSink(line: LogLine): void {
  const out = JSON.stringify(line);
  if (line.level === "error") console.error(out);
  else console.log(out);
}
