import * as React from "react";
import { Link, useParams, useNavigate } from "react-router";
import { Button } from "@carrier/ui";
import { cn } from "@carrier/ui";
import { Plus, Settings, MessageSquare, Loader2, CircleDot, Circle } from "lucide-react";
import type { SessionStatus } from "@carrier/contract";
import { useProject, useSessions, useCreateSession } from "../api/queries";
import { Card, Loading, ErrorState, EmptyState, Input } from "../components/primitives";

function StatusIcon({ status }: { status: SessionStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-green-500" aria-hidden />;
  if (status === "terminated") return <Circle className="h-3.5 w-3.5 text-neutral-400" aria-hidden />;
  return <CircleDot className="h-3.5 w-3.5 text-blue-500" aria-hidden />;
}

/** /:org/:project — session list + project overview (Req 7). */
export function ProjectPage() {
  const { org = "", project = "" } = useParams();
  const navigate = useNavigate();
  const projectQ = useProject(project);
  const sessions = useSessions(project);
  const create = useCreateSession(project);

  const [title, setTitle] = React.useState("");
  const [planMode, setPlanMode] = React.useState(false);

  const startSession = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { title: title.trim() || undefined, planMode },
      {
        onSuccess: (s) => {
          setTitle("");
          navigate(`/${org}/${project}/s/${s.id}`);
        },
      },
    );
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-neutral-500">
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
          className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:underline"
        >
          <Settings className="h-4 w-4" aria-hidden /> Settings
        </Link>
      </div>
      {projectQ.data?.repo ? (
        <p className="mb-4 text-xs text-neutral-500">
          Bound to {projectQ.data.repo.repoFullName} ({projectQ.data.repo.defaultBranch})
        </p>
      ) : (
        <p className="mb-4 text-xs text-neutral-500">Unbound workspace</p>
      )}

      <Card className="mb-6 p-4">
        <h2 className="mb-3 text-sm font-medium">New session</h2>
        <form onSubmit={startSession} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Session title (optional)"
            aria-label="Session title"
          />
          <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={planMode}
              onChange={(e) => setPlanMode(e.target.checked)}
              className="h-4 w-4"
            />
            Plan mode
          </label>
          <Button type="submit" disabled={create.isPending} className="shrink-0">
            <Plus className="h-4 w-4" aria-hidden /> Start
          </Button>
        </form>
        {create.isError ? (
          <p className="mt-2 text-sm text-red-500">{(create.error as Error).message}</p>
        ) : null}
      </Card>

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
                    <p className="truncate text-xs text-neutral-500">
                      {new Date(s.createdAt).toLocaleString()}
                      {s.planMode ? " · plan mode" : ""}
                    </p>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-neutral-500">
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
