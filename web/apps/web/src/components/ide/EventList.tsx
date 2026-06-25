import * as React from "react";
import type { SessionEvent } from "@carrier/contract";
import type { UserMessage } from "../../session/stream";
import { cn } from "@carrier/ui";
import {
  Wrench,
  CheckCircle2,
  XCircle,
  FileCog,
  Brain,
  MessageSquare,
  AlertCircle,
} from "lucide-react";
import { Card, Badge, CardHeader } from "../primitives";

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** A single structured card per SessionEvent kind (Req 10.2). */
export function EventCard({ event }: { event: SessionEvent }) {
  switch (event.kind) {
    case "text":
      return (
        <div className="flex gap-2 px-3 py-2" data-kind="text">
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
          <p className="whitespace-pre-wrap text-sm text-fg">
            {event.text}
          </p>
        </div>
      );
    case "reasoning":
      return (
        <div className="flex gap-2 px-3 py-2" data-kind="reasoning">
          <Brain className="mt-0.5 h-4 w-4 shrink-0 text-untracked" aria-hidden />
          <p className="whitespace-pre-wrap text-sm italic text-fg-muted">{event.text}</p>
        </div>
      );
    case "tool_call":
      return (
        <Card className="mx-3 my-1.5 overflow-hidden" data-kind="tool_call">
          <CardHeader
            tone="neutral"
            mono
            icon={<Wrench className="h-3.5 w-3.5 text-warning" aria-hidden />}
          >
            {event.name}
          </CardHeader>
          <pre className="max-h-48 overflow-auto px-3 py-2 text-xs text-fg-muted">
            {formatInput(event.input)}
          </pre>
        </Card>
      );
    case "tool_result":
      return (
        <Card
          className={cn(
            "mx-3 my-1.5 overflow-hidden",
            event.isError && "border-danger",
          )}
          data-kind="tool_result"
        >
          <CardHeader
            tone="neutral"
            icon={
              event.isError ? (
                <XCircle className="h-3.5 w-3.5 text-danger" aria-hidden />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />
              )
            }
          >
            <span>{event.isError ? "Error" : "Result"}</span>
          </CardHeader>
          <pre className="max-h-48 overflow-auto px-3 py-2 text-xs text-fg-muted">
            {event.content}
          </pre>
        </Card>
      );
    case "file_changed":
      return (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs" data-kind="file_changed">
          <FileCog className="h-3.5 w-3.5 text-info" aria-hidden />
          <Badge className="text-info">
            {event.status}
          </Badge>
          <span className="font-mono text-fg-muted">{event.path}</span>
        </div>
      );
    case "status":
      return (
        <div
          className="px-3 py-1 text-center text-2xs uppercase tracking-wide text-fg-muted"
          data-kind="status"
        >
          {event.state}
        </div>
      );
    case "error":
      return (
        <Card
          className="mx-3 my-1.5 border-danger"
          data-kind="error"
          role="alert"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-danger">
            <AlertCircle className="h-4 w-4" aria-hidden />
            {event.message}
          </div>
        </Card>
      );
    default:
      return null;
  }
}

/** One rendered row: a user prompt, a coalesced text/reasoning stream, or a
 *  structured event card. */
type Row =
  | { kind: "user"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "reasoning"; key: string; text: string }
  | { kind: "event"; key: string; event: SessionEvent };

/** Merge user prompts and events into one seq-ordered transcript, coalescing
 *  consecutive `text` (and `reasoning`) deltas into a single bubble so a streamed
 *  reply renders as one growing message rather than one bubble per token. */
function buildRows(events: SessionEvent[], userMessages: UserMessage[]): Row[] {
  // Sort key is a tuple [seq, rank, ord]: an event ranks before a user message
  // anchored at the same seq, and same-anchor user messages keep send order.
  // This never ties a user message against a real (integer) event seq.
  type Item =
    | { seq: number; rank: 0; ord: number; event: SessionEvent }
    | { seq: number; rank: 1; ord: number; user: UserMessage };
  const items: Item[] = [
    ...events
      // approval_request is surfaced separately; title is metadata (TopBar /
      // session list), not part of the inline transcript.
      .filter((e) => e.kind !== "approval_request" && e.kind !== "title")
      .map((event) => ({ seq: event.seq, rank: 0 as const, ord: 0, event })),
    ...userMessages.map((m) => ({
      seq: m.anchorSeq,
      rank: 1 as const,
      ord: m.ord,
      user: m,
    })),
  ];
  items.sort((a, b) => a.seq - b.seq || a.rank - b.rank || a.ord - b.ord);

  const rows: Row[] = [];
  for (const it of items) {
    if ("user" in it) {
      rows.push({ kind: "user", key: it.user.id, text: it.user.text });
      continue;
    }
    const ev = it.event;
    if (ev.kind === "text" || ev.kind === "reasoning") {
      const last = rows[rows.length - 1];
      if (last && last.kind === ev.kind) {
        last.text += ev.text; // grow the in-progress stream bubble
        continue;
      }
      rows.push({ kind: ev.kind, key: `${ev.kind}-${ev.seq}`, text: ev.text });
      continue;
    }
    rows.push({ kind: "event", key: String(ev.seq), event: ev });
  }
  return rows;
}

/** Scrollable, ordered transcript: user prompts + coalesced agent stream +
 *  structured event cards. Approval requests are surfaced separately. */
export function EventList({
  events,
  userMessages = [],
}: {
  events: SessionEvent[];
  userMessages?: UserMessage[];
}) {
  const rows = buildRows(events, userMessages);
  return (
    <div
      className="flex flex-col py-2"
      data-testid="event-list"
      role="log"
      aria-live="polite"
      aria-atomic="false"
    >
      {rows.map((row) => {
        if (row.kind === "user") {
          return (
            <div key={row.key} className="flex justify-end px-3 py-2" data-kind="user">
              <p className="max-w-[85%] whitespace-pre-wrap border border-line bg-panel px-3 py-1.5 text-sm text-fg">
                {row.text}
              </p>
            </div>
          );
        }
        if (row.kind === "text") {
          return (
            <div key={row.key} className="flex gap-2 px-3 py-2" data-kind="text">
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
              <p className="whitespace-pre-wrap text-sm text-fg">{row.text}</p>
            </div>
          );
        }
        if (row.kind === "reasoning") {
          return (
            <div key={row.key} className="flex gap-2 px-3 py-2" data-kind="reasoning">
              <Brain className="mt-0.5 h-4 w-4 shrink-0 text-untracked" aria-hidden />
              <p className="whitespace-pre-wrap text-sm italic text-fg-muted">{row.text}</p>
            </div>
          );
        }
        return <EventCard key={row.key} event={row.event} />;
      })}
    </div>
  );
}
