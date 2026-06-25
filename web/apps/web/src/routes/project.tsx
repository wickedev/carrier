import * as React from "react";
import { Link, useParams, useNavigate } from "react-router";
import { Button } from "@carrier/ui";
import { Plus, Settings, ArrowRight, GitBranch } from "lucide-react";
import { useProject, useSessions, useCreateSession } from "../api/queries";
import { Loading, ErrorState, EmptyState } from "../components/primitives";
import { PageFrame } from "../components/PageFrame";
import { Breadcrumb, BreadcrumbSep } from "../components/Breadcrumb";
import { SessionStatusPill } from "../components/SessionStatusPill";

const SESSION_COLS = "grid grid-cols-[2.5rem_1fr_6rem_8rem_2rem] items-center gap-3";

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

  const count = sessions.data?.length ?? 0;

  return (
    <PageFrame>
        <Breadcrumb>
          <Link to={`/${org}`} className="hover:underline focus-ring">
            {org}
          </Link>
          <BreadcrumbSep />
          <span className="font-medium text-accent">{projectQ.data?.name ?? project}</span>
          <span className="border border-line px-1.5 text-2xs text-fg-subtle">
            {projectQ.data?.repo
              ? `${projectQ.data.repo.repoFullName} (${projectQ.data.repo.defaultBranch})`
              : "Unbound workspace"}
          </span>
        </Breadcrumb>

        <div className="mt-3 flex items-end justify-between border-b border-line pb-3">
          <h1 className="font-display text-2xl font-bold">SESSIONS</h1>
          <div className="flex items-center gap-2 text-xs">
            <Link
              to={`/${org}/${project}/settings`}
              className="inline-flex items-center gap-1 border border-line px-3 py-1.5 uppercase text-fg-muted hover:border-fg-subtle focus-ring"
            >
              <Settings className="h-3.5 w-3.5" aria-hidden /> Settings
            </Link>
            <Button
              onClick={startSession}
              disabled={create.isPending}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {create.isPending ? "Starting…" : "New session"}
            </Button>
          </div>
        </div>
        {create.isError ? (
          <p className="mt-2 text-sm text-danger">{(create.error as Error).message}</p>
        ) : null}

        {sessions.isLoading ? (
          <Loading />
        ) : sessions.isError ? (
          <ErrorState
            message={(sessions.error as Error).message}
            onRetry={() => sessions.refetch()}
          />
        ) : sessions.data && sessions.data.length > 0 ? (
          <>
            <div
              className={`${SESSION_COLS} mt-4 px-4 pb-1 text-2xs uppercase tracking-[0.15em] text-fg-subtle`}
            >
              <span>#</span>
              <span>Title</span>
              <span>Status</span>
              <span>Created</span>
              <span></span>
            </div>
            <ul className="divide-y divide-line border border-line bg-panel">
              {sessions.data.map((s, i) => (
                <li key={s.id}>
                  <Link
                    to={`/${org}/${project}/s/${s.id}`}
                    className={`${SESSION_COLS} px-4 py-3.5 transition-colors hover:bg-hover focus-ring ${
                      s.archived ? "opacity-60" : ""
                    }`}
                  >
                    <span className="text-accent">{String(i + 1).padStart(2, "0")}</span>
                    <div className="min-w-0">
                      <div className="truncate font-bold">{s.title}</div>
                      <div className="flex items-center gap-1 truncate text-2xs text-fg-subtle">
                        <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                        {s.workingCopy?.branch ?? "no branch"}
                        {s.workingCopy?.dirty ? " · changes" : ""}
                        {s.planMode ? " · plan mode" : ""}
                      </div>
                    </div>
                    <SessionStatusPill status={s.status} />
                    <span className="text-xs text-fg-muted">
                      {new Date(s.createdAt).toLocaleString()}
                    </span>
                    <ArrowRight className="h-4 w-4 text-fg-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs uppercase tracking-[0.1em] text-fg-subtle">
              {count} {count === 1 ? "session" : "sessions"}
            </p>
          </>
        ) : (
          <EmptyState title="No sessions yet" description="Start a session to begin coding." />
        )}
    </PageFrame>
  );
}
