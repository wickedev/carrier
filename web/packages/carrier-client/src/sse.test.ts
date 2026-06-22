import { describe, expect, it } from "vitest";
import { CarrierClient, parseSSE, type RawCarrierEvent } from "./index";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<RawCarrierEvent>): Promise<RawCarrierEvent[]> {
  const out: RawCarrierEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("parseSSE", () => {
  it("parses data frames split across chunks", async () => {
    const frames = collect(
      parseSSE(
        streamOf([
          'data: {"seq":1,"kind":"text","te',
          'xt":"hi"}\n\n',
          'data: {"seq":2,"kind":"status","state":"idle"}\n',
        ]),
      ),
    );
    const got = await frames;
    expect(got).toEqual([
      { seq: 1, kind: "text", text: "hi" },
      { seq: 2, kind: "status", state: "idle" },
    ]);
  });

  it("ignores malformed and non-data lines", async () => {
    const got = await collect(
      parseSSE(streamOf([": comment\n", "data: not-json\n", 'data: {"seq":5,"kind":"text","text":"ok"}\n'])),
    );
    expect(got).toEqual([{ seq: 5, kind: "text", text: "ok" }]);
  });
});

describe("CarrierClient", () => {
  it("createSession posts and returns the id", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ session_id: "carrier-1" }), { status: 200 });
    };
    const client = new CarrierClient({ baseUrl: "http://carrier", token: "t", fetchImpl: fakeFetch });
    const id = await client.createSession({ cwd: "/wc/s1" });
    expect(id).toBe("carrier-1");
    expect(captured!.url).toBe("http://carrier/v1/sessions");
    expect(captured!.init!.method).toBe("POST");
  });

  it("streamEvents yields normalized raw events", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(streamOf(['data: {"seq":1,"kind":"text","text":"yo"}\n']), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const client = new CarrierClient({ baseUrl: "http://carrier", token: "t", fetchImpl: fakeFetch });
    const got = await collect(client.streamEvents("s1"));
    expect(got[0]).toEqual({ seq: 1, kind: "text", text: "yo" });
  });
});
