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
  Terminal,
  FileText,
  FolderTree,
  FolderSearch,
  Search,
  FilePlus,
  Pencil,
  FilePen,
  FileStack,
  NotebookPen,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  ScrollText,
  CircleStop,
  Keyboard,
  Image as ImageIcon,
  Stethoscope,
  PackageSearch,
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

/** Per-tool icon for the first-class file tools (others fall back to Wrench). */
const TOOL_ICON: Record<string, typeof Wrench> = {
  bash: Terminal,
  bash_output: ScrollText,
  write_stdin: Keyboard,
  kill_shell: CircleStop,
  read: FileText,
  ls: FolderTree,
  glob: FolderSearch,
  grep: Search,
  write: FilePlus,
  edit: Pencil,
  multi_edit: FilePen,
  apply_patch: FileStack,
  notebook_edit: NotebookPen,
  view_image: ImageIcon,
  lsp: Stethoscope,
  tool_search: PackageSearch,
  web_fetch: Globe,
  todo_write: ListChecks,
  todo_read: ListChecks,
  ask_user: MessageCircleQuestion,
};

/** A compact view of a tool call: a one-line `primary` arg for the header, and
 *  an optional `body` block (kept only where the full args matter, e.g. bash). */
function toolCallView(name: string, input: unknown): { primary: string; body: string | null } {
  const o = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) ?? {};
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  switch (name) {
    case "bash":
      return {
        primary: o.run_in_background ? "background" : "",
        body: s("command") || formatInput(input),
      };
    case "bash_output":
      return { primary: s("bash_id") + (s("filter") ? `  /${s("filter")}/` : ""), body: null };
    case "write_stdin":
      return { primary: s("bash_id"), body: s("input") || null };
    case "kill_shell":
      return { primary: s("shell_id"), body: null };
    case "read": {
      const range = o.offset || o.limit ? ` :${(o.offset as number) ?? 1}+${(o.limit as number) ?? ""}` : "";
      return { primary: s("path") + range, body: null };
    }
    case "ls":
      return { primary: s("path") || ".", body: null };
    case "glob":
      return { primary: s("pattern") + (s("path") ? ` in ${s("path")}` : ""), body: null };
    case "grep":
      return { primary: s("pattern") + (s("include") ? `  (${s("include")})` : ""), body: null };
    case "write":
    case "edit":
      return { primary: s("path"), body: null };
    case "multi_edit": {
      const n = Array.isArray(o.edits) ? o.edits.length : 0;
      return { primary: `${s("path")}  (${n} edit${n === 1 ? "" : "s"})`, body: null };
    }
    case "apply_patch": {
      const n = Array.isArray(o.operations) ? o.operations.length : 0;
      return { primary: `${n} operation${n === 1 ? "" : "s"}`, body: null };
    }
    case "notebook_edit":
      return { primary: `${s("path")}  #${(o.cell_index as number) ?? 0} ${s("edit_mode") || "replace"}`, body: null };
    case "web_fetch":
      return { primary: s("url"), body: null };
    case "view_image":
      return { primary: s("path"), body: null };
    case "lsp": {
      const pos = o.line !== undefined ? `:${o.line as number}` : "";
      return { primary: s("path") + pos, body: null };
    }
    case "todo_write": {
      const n = Array.isArray(o.todos) ? o.todos.length : 0;
      return { primary: `${n} task${n === 1 ? "" : "s"}`, body: null };
    }
    case "todo_read":
      return { primary: "", body: null };
    case "tool_search":
      return { primary: s("query"), body: null };
    case "ask_user":
      return { primary: s("question"), body: null };
    default:
      return { primary: "", body: formatInput(input) };
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
    case "tool_call": {
      const Icon = TOOL_ICON[event.name] ?? Wrench;
      const { primary, body } = toolCallView(event.name, event.input);
      return (
        <Card className="mx-3 my-1.5 overflow-hidden" data-kind="tool_call">
          <CardHeader
            tone="neutral"
            mono
            icon={<Icon className="h-3.5 w-3.5 text-warning" aria-hidden />}
          >
            <span className="text-fg">{event.name}</span>
            {primary ? <span className="ml-2 text-fg-muted">{primary}</span> : null}
          </CardHeader>
          {body ? (
            <pre className="max-h-48 overflow-auto px-3 py-2 text-xs text-fg-muted">
              {body}
            </pre>
          ) : null}
        </Card>
      );
    }
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
      // approval_request and question are surfaced separately (as cards); title
      // is metadata (TopBar / session list), not part of the inline transcript.
      .filter(
        (e) => e.kind !== "approval_request" && e.kind !== "question" && e.kind !== "title",
      )
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
