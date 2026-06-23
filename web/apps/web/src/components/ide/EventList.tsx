import * as React from "react";
import type { SessionEvent } from "@carrier/contract";
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
import { Card, Badge } from "../primitives";

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
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
          <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-100">
            {event.text}
          </p>
        </div>
      );
    case "reasoning":
      return (
        <div className="flex gap-2 px-3 py-2" data-kind="reasoning">
          <Brain className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" aria-hidden />
          <p className="whitespace-pre-wrap text-sm italic text-fg-muted">{event.text}</p>
        </div>
      );
    case "tool_call":
      return (
        <Card className="mx-3 my-1.5 overflow-hidden" data-kind="tool_call">
          <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium dark:border-neutral-800 dark:bg-neutral-800/50">
            <Wrench className="h-3.5 w-3.5 text-amber-500" aria-hidden />
            <span className="font-mono">{event.name}</span>
          </div>
          <pre className="max-h-48 overflow-auto px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300">
            {formatInput(event.input)}
          </pre>
        </Card>
      );
    case "tool_result":
      return (
        <Card
          className={cn(
            "mx-3 my-1.5 overflow-hidden",
            event.isError && "border-red-300 dark:border-red-900",
          )}
          data-kind="tool_result"
        >
          <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium dark:border-neutral-800 dark:bg-neutral-800/50">
            {event.isError ? (
              <XCircle className="h-3.5 w-3.5 text-danger" aria-hidden />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" aria-hidden />
            )}
            <span>{event.isError ? "Error" : "Result"}</span>
          </div>
          <pre className="max-h-48 overflow-auto px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300">
            {event.content}
          </pre>
        </Card>
      );
    case "file_changed":
      return (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs" data-kind="file_changed">
          <FileCog className="h-3.5 w-3.5 text-blue-500" aria-hidden />
          <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {event.status}
          </Badge>
          <span className="font-mono text-neutral-600 dark:text-neutral-400">{event.path}</span>
        </div>
      );
    case "status":
      return (
        <div
          className="px-3 py-1 text-center text-[11px] uppercase tracking-wide text-fg-muted"
          data-kind="status"
        >
          {event.state}
        </div>
      );
    case "error":
      return (
        <Card
          className="mx-3 my-1.5 border-red-300 dark:border-red-900"
          data-kind="error"
          role="alert"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4" aria-hidden />
            {event.message}
          </div>
        </Card>
      );
    default:
      return null;
  }
}

/** Scrollable, ordered event log. Approval requests are surfaced separately. */
export function EventList({ events }: { events: SessionEvent[] }) {
  // approval_request is surfaced separately; title is metadata (drives the
  // TopBar / session list, not rendered inline in the event log).
  const visible = events.filter(
    (e) => e.kind !== "approval_request" && e.kind !== "title",
  );
  return (
    <div
      className="flex flex-col py-2"
      data-testid="event-list"
      role="log"
      aria-live="polite"
      aria-atomic="false"
    >
      {visible.map((e) => (
        <EventCard key={e.seq} event={e} />
      ))}
    </div>
  );
}
