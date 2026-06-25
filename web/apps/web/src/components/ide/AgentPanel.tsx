import * as React from "react";
import type { SessionEvent } from "@carrier/contract";
import { EventList } from "./EventList";
import { ApprovalCard } from "./ApprovalCard";
import { Composer, type SendOptions } from "./Composer";
import { EmptyState } from "../primitives";
import type { PendingApproval } from "../../session/stream";

/**
 * AgentPanel — the right pane: streamed event log + pending approvals + composer.
 */
export function AgentPanel({
  events,
  approvals,
  running,
  sending,
  onSend,
  onInterrupt,
  onDecide,
  decidingReqId,
  onApprovalExpire,
}: {
  events: SessionEvent[];
  approvals: PendingApproval[];
  running: boolean;
  sending?: boolean;
  onSend: (text: string, opts: SendOptions) => void;
  onInterrupt: () => void;
  onDecide: (reqId: string, allow: boolean) => void;
  decidingReqId?: string | null;
  onApprovalExpire?: (reqId: string) => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Autoscroll to bottom on new events / approvals.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, approvals.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-3 py-2 text-2xs uppercase tracking-[0.15em] text-fg-subtle">
        Agent stream
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto" data-testid="agent-scroll">
        {events.length === 0 && approvals.length === 0 ? (
          <EmptyState title="No activity yet" description="Send a message to start the session." />
        ) : (
          <>
            <EventList events={events} />
            {approvals.map((a) => (
              <ApprovalCard
                key={a.reqId}
                approval={a}
                onDecide={onDecide}
                pending={decidingReqId === a.reqId}
                onExpire={onApprovalExpire}
              />
            ))}
          </>
        )}
      </div>
      <Composer
        running={running}
        sending={sending}
        onSend={onSend}
        onInterrupt={onInterrupt}
      />
    </div>
  );
}
