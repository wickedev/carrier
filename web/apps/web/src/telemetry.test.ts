import { describe, it, expect, vi, afterEach } from "vitest";
import {
  setTelemetrySink,
  consoleSink,
  recordRouteChange,
  recordError,
  installGlobalErrorTelemetry,
  type TelemetryEvent,
} from "./telemetry";

afterEach(() => setTelemetrySink(consoleSink));

describe("telemetry (Task 24)", () => {
  it("records route changes to the active sink", () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink((e) => events.push(e));
    recordRouteChange("/acme/web");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "route_change", path: "/acme/web" });
  });

  it("records errors with name + message", () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink((e) => events.push(e));
    recordError(new TypeError("boom"), "test");
    expect(events[0]).toMatchObject({
      type: "error",
      name: "TypeError",
      message: "boom",
      source: "test",
    });
  });

  it("captures window errors via the global handler", () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink((e) => events.push(e));
    const dispose = installGlobalErrorTelemetry();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("global"), message: "global" }));
    expect(events.some((e) => e.type === "error" && e.message === "global")).toBe(true);
    dispose();
  });

  it("never throws even if the sink throws", () => {
    setTelemetrySink(() => {
      throw new Error("sink failure");
    });
    expect(() => recordRouteChange("/x")).not.toThrow();
  });

  it("default console sink does not throw", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    setTelemetrySink(consoleSink);
    recordRouteChange("/y");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
