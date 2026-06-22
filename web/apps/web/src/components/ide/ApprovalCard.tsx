import * as React from "react";
import { Button } from "@carrier/ui";
import { ShieldAlert } from "lucide-react";
import { Card } from "../primitives";
import type { PendingApproval } from "../../session/stream";

/**
 * HITL approval card (Req 11). Renders the tool/resource/reason and approve/deny
 * controls; correlates the decision to the originating request by `reqId`.
 */
export function ApprovalCard({
  approval,
  onDecide,
  pending,
}: {
  approval: PendingApproval;
  onDecide: (reqId: string, allow: boolean) => void;
  pending?: boolean;
}) {
  return (
    <Card
      className="mx-3 my-2 border-amber-300 dark:border-amber-800"
      role="alertdialog"
      aria-label={`Approval request: ${approval.tool}`}
      data-testid="approval-card"
    >
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        <ShieldAlert className="h-4 w-4" aria-hidden />
        Approval required
      </div>
      <div className="space-y-1 px-3 py-2 text-sm">
        <p>
          <span className="text-neutral-500">Tool:</span>{" "}
          <span className="font-mono">{approval.tool}</span>
        </p>
        <p className="break-all">
          <span className="text-neutral-500">Resource:</span>{" "}
          <span className="font-mono">{approval.resource}</span>
        </p>
        <p className="text-neutral-600 dark:text-neutral-300">{approval.reason}</p>
      </div>
      <div className="flex justify-end gap-2 px-3 pb-3">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onDecide(approval.reqId, false)}
        >
          Deny
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => onDecide(approval.reqId, true)}
        >
          Approve
        </Button>
      </div>
    </Card>
  );
}
