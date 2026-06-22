import { describe, it, expect, vi } from "vitest";
import {
  createSessionStreamStore,
  connectSessionStream,
  type EventSourceLike,
} from "./stream";

class FakeEventSource implements EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => unknown) | null = null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null = null;
  onmessage: ((this: unknown, ev: { data: string }) => unknown) | null = null;
  closed = false;
  static instances: FakeEventSource[] = [];
  constructor() {
    FakeEventSource.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.call(this, { data: JSON.stringify(data) });
  }
  open() {
    this.onopen?.call(this, {});
  }
  fail() {
    this.onerror?.call(this, {});
  }
  close() {
    this.closed = true;
  }
}

describe("connectSessionStream transport", () => {
  it("feeds parsed messages into the store and marks the connection open", () => {
    FakeEventSource.instances = [];
    const store = createSessionStreamStore();
    const dispose = connectSessionStream("/bff/sessions/s1/events", {
      store,
      factory: () => new FakeEventSource(),
    });
    const es = FakeEventSource.instances[0]!;
    es.open();
    expect(store.getState().connection).toBe("open");
    es.emit({ seq: 1, kind: "text", text: "hi" });
    expect(store.getState().events).toHaveLength(1);
    dispose();
    expect(es.closed).toBe(true);
    expect(store.getState().connection).toBe("closed");
  });

  it("reconnects with backoff after an error using a fresh EventSource", () => {
    FakeEventSource.instances = [];
    const timers: Array<() => void> = [];
    const store = createSessionStreamStore();
    const dispose = connectSessionStream("/bff/sessions/s1/events", {
      store,
      factory: () => new FakeEventSource(),
      backoff: [10],
      setTimeoutFn: ((cb: () => void) => {
        timers.push(cb);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: () => {},
    });

    const first = FakeEventSource.instances[0]!;
    first.open();
    first.fail();
    expect(store.getState().connection).toBe("reconnecting");
    expect(first.closed).toBe(true);
    // fire the scheduled reconnect
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1]!;
    second.open();
    // dedupe still works across reconnect: replay seq 1 then live seq 2
    second.emit({ seq: 1, kind: "text", text: "hi" });
    second.emit({ seq: 1, kind: "text", text: "hi" });
    second.emit({ seq: 2, kind: "status", state: "running" });
    expect(store.getState().events.map((e) => e.seq)).toEqual([1, 2]);
    dispose();
  });
});
