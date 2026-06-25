import * as React from "react";
import { Link, useParams, useNavigate } from "react-router";
import { Button } from "@carrier/ui";
import { cn } from "@carrier/ui";
import { Plus, Settings, MessageSquare, Loader2, CircleDot, Circle } from "lucide-react";
import type { SessionStatus } from "@carrier/contract";
import { useProject, useSessions, useCreateSession } from "../api/queries";
import { Card, Loading, ErrorState, EmptyState } from "../components/primitives";

function StatusIcon({ status }: { status: SessionStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-success motion-reduce:animate-none" aria-hidden />;
  if (status === "terminated") return <Circle className="h-3.5 w-3.5 text-neutral-400" aria-hidden />;
  return <CircleDot className="h-3.5 w-3.5 text-info" aria-hidden />;
}

/** /:org/:project — session list + project overview (Req 7). */
export function ProjectPage() {
  const { org = "", project = "" } = useParams();
  const navigate = useNavigate();
  const projectQ = useProject(project);
  const sessions = useSessions(project);
  const create = useCreateSession(project);

  // One-click session start. The title is auto-generated: a new session begins as
  // "Untitled" and the runtime renames it to a summary on the first LLM turn — so
  // there is nothing to fill in at creation.
  const startSession = () => {
    create.mutate(
      {},
      {
        onSuccess: (s) => navigate(`/${org}/${project}/s/${s.id}`),
      },
    );
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Link to={`/${org}`} className="hover:underline">
            {org}
          </Link>
          <span>/</span>
          <span className="font-medium text-neutral-800 dark:text-neutral-100">
            {projectQ.data?.name ?? project}
          </span>
        </div>
        <Link
          to={`/${org}/${project}/settings`}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
        >
          <Settings className="h-4 w-4" aria-hidden /> Settings
        </Link>
      </div>
      {projectQ.data?.repo ? (
        <p className="mb-4 text-xs text-fg-muted">
          Bound to {projectQ.data.repo.repoFullName} ({projectQ.data.repo.defaultBranch})
        </p>
      ) : (
        <p className="mb-4 text-xs text-fg-muted">Unbound workspace</p>
      )}

      <div className="mb-6">
        <Button onClick={startSession} disabled={create.isPending}>
          <Plus className="h-4 w-4" aria-hidden />
          {create.isPending ? "Starting…" : "New session"}
        </Button>
        {create.isError ? (
          <p className="mt-2 text-sm text-danger">{(create.error as Error).message}</p>
        ) : null}
      </div>

      <h2 className="mb-2 text-sm font-medium">Sessions</h2>
      {sessions.isLoading ? (
        <Loading />
      ) : sessions.isError ? (
        <ErrorState message={(sessions.error as Error).message} onRetry={() => sessions.refetch()} />
      ) : sessions.data && sessions.data.length > 0 ? (
        <ul className="space-y-2">
          {sessions.data.map((s) => (
            <li key={s.id}>
              <Link to={`/${org}/${project}/s/${s.id}`}>
                <Card
                  className={cn(
                    "flex items-center gap-3 p-3 transition-colors hover:border-neutral-300 dark:hover:border-neutral-700",
                    s.archived && "opacity-60",
                  )}
                >
                  <MessageSquare className="h-4 w-4 text-neutral-400" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.title}</p>
                    <p className="truncate text-xs text-fg-muted">
                      {new Date(s.createdAt).toLocaleString()}
                      {s.planMode ? " · plan mode" : ""}
                    </p>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-fg-muted">
                    <StatusIcon status={s.status} />
                    {s.status}
                  </span>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No sessions yet" description="Start a session to begin coding." />
      )}
    </div>
  );
}
