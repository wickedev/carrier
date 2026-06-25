import * as React from "react";
import { Link } from "react-router";
import { Button } from "@carrier/ui";
import { cn } from "@carrier/ui";
import {
  GitBranch,
  GitPullRequest,
  GitMerge,
  CircleDot,
  Circle,
  Loader2,
  ChevronRight,
} from "lucide-react";
import type { Session, SessionStatus, Usage } from "@carrier/contract";
import type { ConnectionState } from "../../session/stream";
import { Spinner } from "../primitives";
import { UsagePill } from "./UsagePanel";

function StatusDot({ status }: { status: SessionStatus }) {
  if (status === "running")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> running
      </span>
    );
  if (status === "terminated")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <Circle className="h-3 w-3" aria-hidden /> terminated
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-info">
      <CircleDot className="h-3 w-3" aria-hidden /> idle
    </span>
  );
}

function ConnectionPill({ connection }: { connection: ConnectionState }) {
  const map: Record<ConnectionState, { label: string; cls: string }> = {
    idle: { label: "idle", cls: "text-fg-muted" },
    connecting: { label: "connecting…", cls: "text-warning" },
    open: { label: "live", cls: "text-success" },
    reconnecting: { label: "reconnecting…", cls: "text-warning" },
    closed: { label: "disconnected", cls: "text-danger" },
  };
  const { label, cls } = map[connection];
  return <span className={cn("text-2xs font-medium", cls)}>{label}</span>;
}

/** IDE top bar: breadcrumb, branch/PR, run status, promote + run controls (Req 15.3). */
export function TopBar({
  orgSlug,
  projectId,
  session,
  repoBound,
  status,
  connection,
  onPromote,
  promoting,
  prUrl,
  promoteStatus,
  usage,
  usageLoading,
}: {
  orgSlug: string;
  projectId: string;
  session: Session | undefined;
  /** Whether the project is bound to a repo. Bound → promote opens a PR;
   *  unbound → promote merges directly into the base workspace. */
  repoBound?: boolean;
  status: SessionStatus;
  connection: ConnectionState;
  onPromote: () => void;
  promoting?: boolean;
  prUrl?: string | null;
  /** Outcome of the last promote (e.g. "merged", "PR opened", conflict text). */
  promoteStatus?: string | null;
  usage?: Usage;
  usageLoading?: boolean;
}) {
  const branch = session?.workingCopy?.branch ?? null;
  // Unbound projects merge directly to base — gate that destructive-ish action
  // behind a two-step confirm (mirrors the settings.tsx DangerZone pattern).
  const [confirmingMerge, setConfirmingMerge] = React.useState(false);
  return (
    <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2 text-xs">
      <nav
        className="flex items-center gap-2 uppercase tracking-[0.1em] text-fg-muted"
        aria-label="Breadcrumb"
      >
        <Link to={`/${orgSlug}`} className="hover:underline">
          {orgSlug}
        </Link>
        <span className="text-fg-subtle" aria-hidden>
          /
        </span>
        <Link to={`/${orgSlug}/${projectId}`} className="hover:underline">
          {projectId}
        </Link>
        <span className="text-fg-subtle" aria-hidden>
          /
        </span>
        <span className="font-bold text-fg">{session?.title ?? "Session"}</span>
      </nav>

      {branch ? (
        <span className="inline-flex items-center gap-1 border border-line px-2 py-0.5 font-mono text-xs text-fg-muted">
          <GitBranch className="h-3 w-3" aria-hidden />
          {branch}
          {session?.workingCopy?.dirty ? (
            <span className="text-warning" title="Uncommitted changes">
              •
            </span>
          ) : null}
        </span>
      ) : null}

      {promoteStatus ? (
        <span
          className="border border-line px-2 py-0.5 text-2xs uppercase tracking-[0.1em] text-fg-muted"
          data-testid="promote-status"
        >
          {promoteStatus}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        <UsagePill usage={usage} loading={usageLoading} />
        <ConnectionPill connection={connection} />
        <StatusDot status={status} />
        {prUrl ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-info hover:underline"
            data-testid="pr-link"
          >
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> PR
          </a>
        ) : null}
        {repoBound === undefined ? (
          // Binding not yet known — keep the action disabled and neutral so we
          // never show or fire the destructive "Merge to base" prematurely.
          <Button
            size="sm"
            variant="outline"
            disabled
            title="Checking repository binding…"
          >
            <Spinner /> Promote
          </Button>
        ) : repoBound ? (
          <Button
            size="sm"
            className="btn-primary"
            onClick={onPromote}
            disabled={promoting}
            title="Open a pull request from this session's branch"
          >
            {promoting ? <Spinner /> : <GitPullRequest className="h-3.5 w-3.5" aria-hidden />}
            Open PR
          </Button>
        ) : confirmingMerge ? (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="btn-primary"
              onClick={() => {
                setConfirmingMerge(false);
                onPromote();
              }}
              disabled={promoting}
              title="Merge this session's changes into the base workspace"
            >
              {promoting ? <Spinner /> : <GitMerge className="h-3.5 w-3.5" aria-hidden />}
              Confirm merge
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingMerge(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="btn-primary"
            onClick={() => setConfirmingMerge(true)}
            disabled={promoting}
            title="Merge this session's changes into the base workspace"
          >
            {promoting ? <Spinner /> : <GitMerge className="h-3.5 w-3.5" aria-hidden />}
            Merge to base
          </Button>
        )}
      </div>
    </div>
  );
}
