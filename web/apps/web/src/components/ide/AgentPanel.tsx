import * as React from "react";
import type { SessionEvent } from "@carrier/contract";
import { EventList } from "./EventList";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
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
}: {
  events: SessionEvent[];
  approvals: PendingApproval[];
  running: boolean;
  sending?: boolean;
  onSend: (text: string, steer: boolean) => void;
  onInterrupt: () => void;
  onDecide: (reqId: string, allow: boolean) => void;
  decidingReqId?: string | null;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Autoscroll to bottom on new events / approvals.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, approvals.length]);

  return (
    <div className="flex h-full flex-col">
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
