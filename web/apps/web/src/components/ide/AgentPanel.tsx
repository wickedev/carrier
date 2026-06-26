import * as React from "react";
import type { SessionEvent } from "@carrier/contract";
import { EventList } from "./EventList";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Composer, type SendOptions, type SessionDefaults } from "./Composer";
import { EmptyState } from "../primitives";
import type { PendingApproval, PendingQuestion, UserMessage } from "../../session/stream";

/**
 * AgentPanel — the right pane: streamed event log + pending approvals + composer.
 */
export function AgentPanel({
  events,
  userMessages,
  approvals,
  questions,
  running,
  sending,
  onSend,
  onInterrupt,
  onDecide,
  decidingReqId,
  onApprovalExpire,
  onAnswer,
  answeringReqId,
  defaults,
}: {
  events: SessionEvent[];
  userMessages: UserMessage[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  running: boolean;
  sending?: boolean;
  onSend: (text: string, opts: SendOptions) => void;
  onInterrupt: () => void;
  onDecide: (reqId: string, allow: boolean) => void;
  decidingReqId?: string | null;
  onApprovalExpire?: (reqId: string) => void;
  onAnswer: (reqId: string, answer: string) => void;
  answeringReqId?: string | null;
  defaults: SessionDefaults;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Autoscroll to bottom on new events / approvals.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, approvals.length, questions.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 items-center border-b border-line px-3 text-2xs uppercase tracking-[0.15em] text-fg-subtle">
        Agent stream
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto" data-testid="agent-scroll">
        {events.length === 0 &&
        userMessages.length === 0 &&
        approvals.length === 0 &&
        questions.length === 0 ? (
          <EmptyState title="No activity yet" description="Send a message to start the session." />
        ) : (
          <>
            <EventList events={events} userMessages={userMessages} />
            {approvals.map((a) => (
              <ApprovalCard
                key={a.reqId}
                approval={a}
                onDecide={onDecide}
                pending={decidingReqId === a.reqId}
                onExpire={onApprovalExpire}
              />
            ))}
            {questions.map((q) => (
              <QuestionCard
                key={q.reqId}
                question={q}
                onAnswer={onAnswer}
                pending={answeringReqId === q.reqId}
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
        defaults={defaults}
      />
    </div>
  );
}
