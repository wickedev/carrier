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
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> running
      </span>
    );
  if (status === "terminated")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <Circle className="h-3 w-3" aria-hidden /> terminated
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
      <CircleDot className="h-3 w-3" aria-hidden /> idle
    </span>
  );
}

function ConnectionPill({ connection }: { connection: ConnectionState }) {
  const map: Record<ConnectionState, { label: string; cls: string }> = {
    idle: { label: "idle", cls: "text-fg-muted" },
    connecting: { label: "connecting…", cls: "text-amber-500" },
    open: { label: "live", cls: "text-green-600 dark:text-green-400" },
    reconnecting: { label: "reconnecting…", cls: "text-amber-500" },
    closed: { label: "disconnected", cls: "text-red-500" },
  };
  const { label, cls } = map[connection];
  return <span className={cn("text-[11px] font-medium", cls)}>{label}</span>;
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
    <div className="flex items-center gap-3 border-b border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-800">
      <nav className="flex items-center gap-1 text-fg-muted" aria-label="Breadcrumb">
        <Link to={`/${orgSlug}`} className="hover:underline">
          {orgSlug}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <Link to={`/${orgSlug}/${projectId}`} className="hover:underline">
          {projectId}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span className="text-neutral-800 dark:text-neutral-100">
          {session?.title ?? "Session"}
        </span>
      </nav>

      {branch ? (
        <span className="inline-flex items-center gap-1 rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
          <GitBranch className="h-3 w-3" aria-hidden />
          {branch}
          {session?.workingCopy?.dirty ? (
            <span className="text-amber-500" title="Uncommitted changes">
              •
            </span>
          ) : null}
        </span>
      ) : null}

      {promoteStatus ? (
        <span
          className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
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
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
            data-testid="pr-link"
          >
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> PR
          </a>
        ) : null}
        {repoBound ? (
          <Button
            size="sm"
            variant="outline"
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
              variant="outline"
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
            variant="outline"
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
