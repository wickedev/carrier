/**
 * telemetry.ts — minimal web telemetry (Req/Task 24).
 *
 * No external dependency. Records two classes of signal:
 *  - route changes (navigation),
 *  - unhandled errors / promise rejections, and errors surfaced by the React
 *    ErrorBoundary.
 *
 * Events go to a pluggable sink (the console sink by default). Tests and prod
 * wiring can swap the sink via `setTelemetrySink`. Secrets are never recorded —
 * only paths and error messages/names are captured.
 */

export type TelemetryEvent =
  | { type: "route_change"; path: string; ts: number }
  | { type: "error"; name: string; message: string; stack?: string; source: string; ts: number };

export type TelemetrySink = (event: TelemetryEvent) => void;

/** Default sink: structured console logging. */
export const consoleSink: TelemetrySink = (event) => {
  if (event.type === "error") {
    // eslint-disable-next-line no-console
    console.error("[telemetry]", event);
  } else {
    // eslint-disable-next-line no-console
    console.info("[telemetry]", event);
  }
};

let sink: TelemetrySink = consoleSink;

/** Swap the sink (e.g. to forward to a backend, or capture in tests). */
export function setTelemetrySink(next: TelemetrySink): void {
  sink = next;
}

/** Record an arbitrary telemetry event through the active sink. */
export function record(event: TelemetryEvent): void {
  try {
    sink(event);
  } catch {
    /* never let telemetry crash the app */
  }
}

/** Record a route/navigation change. */
export function recordRouteChange(path: string): void {
  record({ type: "route_change", path, ts: Date.now() });
}

/** Record an error from any source (boundary, window handlers, manual). */
export function recordError(error: unknown, source: string): void {
  const err = error instanceof Error ? error : new Error(String(error));
  record({
    type: "error",
    name: err.name,
    message: err.message,
    stack: err.stack,
    source,
    ts: Date.now(),
  });
}

let installed = false;

/**
 * Install global handlers for unhandled errors + rejections. Idempotent.
 * Returns a disposer that removes the listeners.
 */
export function installGlobalErrorTelemetry(): () => void {
  if (installed || typeof window === "undefined") return () => undefined;
  installed = true;

  const onError = (ev: ErrorEvent) => {
    recordError(ev.error ?? ev.message, "window.error");
  };
  const onRejection = (ev: PromiseRejectionEvent) => {
    recordError(ev.reason, "unhandledrejection");
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    installed = false;
  };
}
