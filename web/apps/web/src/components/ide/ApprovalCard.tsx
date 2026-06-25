import * as React from "react";
import { Button } from "@carrier/ui";
import { ShieldAlert, Clock } from "lucide-react";
import { Card, Badge, CardHeader } from "../primitives";
import type { PendingApproval } from "../../session/stream";

/** Default approval timeout: after this, the request is treated as auto-denied. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * HITL approval card (Req 11). Renders the tool/resource/reason and approve/deny
 * controls; correlates the decision to the originating request by `reqId`.
 *
 * Timeout/expiry (Req 11.4): an unanswered request expires after `timeoutMs`
 * (measured from `approval.receivedAt`). Once expired it is surfaced as a
 * timeout-denial — the Approve control is disabled and the card shows an
 * "Expired" state. `onExpire` fires once so the page can record/clear it.
 */
export function ApprovalCard({
  approval,
  onDecide,
  pending,
  timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  onExpire,
  now,
}: {
  approval: PendingApproval;
  onDecide: (reqId: string, allow: boolean) => void;
  pending?: boolean;
  timeoutMs?: number;
  onExpire?: (reqId: string) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}) {
  const clock = now ?? Date.now;
  const deadline = approval.receivedAt + timeoutMs;
  const [expired, setExpired] = React.useState(() => clock() >= deadline);

  React.useEffect(() => {
    if (expired) return;
    const remaining = deadline - clock();
    const id = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [deadline, expired, clock]);

  const firedRef = React.useRef(false);
  React.useEffect(() => {
    if (expired && !firedRef.current) {
      firedRef.current = true;
      onExpire?.(approval.reqId);
    }
  }, [expired, approval.reqId, onExpire]);

  // Move focus to the card container on mount so screen readers announce the
  // alertdialog. We intentionally focus the container (not the Approve button)
  // to avoid an accidental Enter-to-approve.
  const cardRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    cardRef.current?.focus();
  }, []);

  return (
    <Card
      ref={cardRef}
      tabIndex={-1}
      className="mx-3 my-2 border-warning"
      role="alertdialog"
      aria-label={`Approval request: ${approval.tool}`}
      data-testid="approval-card"
    >
      <CardHeader
        tone="amber"
        icon={<ShieldAlert className="h-4 w-4" aria-hidden />}
        trailing={
          expired ? (
            <Badge
              className="ml-auto text-danger"
              data-testid="approval-expired"
            >
              <Clock className="mr-1 h-3 w-3" aria-hidden /> Expired
            </Badge>
          ) : null
        }
      >
        Approval required
      </CardHeader>
      <div className="space-y-1 px-3 py-2 text-sm">
        <p>
          <span className="text-fg-muted">Tool:</span>{" "}
          <span className="font-mono">{approval.tool}</span>
        </p>
        <p className="break-all">
          <span className="text-fg-muted">Resource:</span>{" "}
          <span className="font-mono">{approval.resource}</span>
        </p>
        <p className="text-fg-muted">{approval.reason}</p>
        {expired ? (
          <p className="text-xs text-danger">
            This request timed out and was auto-denied.
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 px-3 pb-3">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onDecide(approval.reqId, false)}
        >
          {expired ? "Dismiss" : "Deny"}
        </Button>
        <Button
          size="sm"
          disabled={pending || expired}
          onClick={() => onDecide(approval.reqId, true)}
        >
          Approve
        </Button>
      </div>
    </Card>
  );
}
