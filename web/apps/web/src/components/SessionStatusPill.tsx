import * as React from "react";
import { Loader2, CircleDot, Circle } from "lucide-react";
import type { SessionStatus } from "@carrier/contract";

/**
 * SessionStatusPill — the shared session status indicator used in the project
 * session list and the IDE TopBar. Maps running→success (spinner), idle→info,
 * terminated→subtle, with UPPERCASE labels RUNNING / IDLE / ENDED.
 */
export function SessionStatusPill({ status }: { status: SessionStatus }) {
  if (status === "running")
    return (
      <span className="inline-flex items-center gap-1 text-xs uppercase tracking-[0.1em] text-success">
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Running
      </span>
    );
  if (status === "terminated")
    return (
      <span className="inline-flex items-center gap-1 text-xs uppercase tracking-[0.1em] text-fg-subtle">
        <Circle className="h-3.5 w-3.5" aria-hidden />
        Ended
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs uppercase tracking-[0.1em] text-info">
      <CircleDot className="h-3.5 w-3.5" aria-hidden />
      Idle
    </span>
  );
}
