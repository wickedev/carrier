import * as React from "react";
import { Link, useParams } from "react-router";
import { Button } from "@carrier/ui";
import { Plus, FolderGit2, Settings, Github, X, Loader2, ArrowRight } from "lucide-react";
import { useProjects, useCreateProject, useInstallations } from "../api/queries";
import { Card, Input, Loading, ErrorState, EmptyState } from "../components/primitives";
import { useToast } from "../components/toast";

/** /:org — project list within an org/personal context (Req 4). */
export function OrgPage() {
  const { org = "" } = useParams();
  const projects = useProjects(org);
  const [showNew, setShowNew] = React.useState(false);
  const count = projects.data?.length ?? 0;

  return (
    <div className="grid-rule min-h-[calc(100vh-3.25rem)]">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-0 flex items-end justify-between border-b border-line pb-3">
          <div>
            <h1 className="font-display text-2xl font-bold">PROJECTS</h1>
            <p className="text-xs uppercase tracking-[0.1em] text-fg-muted">
              {org} — {count} {count === 1 ? "project" : "projects"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Link
              to={`/${org}/settings`}
              className="inline-flex items-center gap-1 border border-line px-3 py-1.5 uppercase text-fg-muted hover:border-fg-subtle focus-ring"
            >
              <Settings className="h-3.5 w-3.5" aria-hidden /> Org settings
            </Link>
            <Button
              onClick={() => setShowNew(true)}
              data-testid="new-project-button"
              className="btn-primary px-3 py-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> New project
            </Button>
          </div>
        </div>

        {projects.isLoading ? (
          <Loading />
        ) : projects.isError ? (
          <ErrorState
            message={(projects.error as Error).message}
            onRetry={() => projects.refetch()}
          />
        ) : projects.data && projects.data.length > 0 ? (
          <>
            <ul className="divide-y divide-line border-b border-line">
              {projects.data.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/${org}/${p.id}`}
                    className="flex items-center gap-4 px-3 py-4 transition-colors hover:bg-panel focus-ring"
                  >
                    <FolderGit2 className="h-5 w-5 shrink-0 text-accent" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-bold">{p.name}</span>
                        {p.repo ? null : (
                          <span className="border border-line px-1.5 text-2xs uppercase tracking-[0.1em] text-fg-subtle">
                            Unbound
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-fg-muted">
                        {p.repo ? p.repo.repoFullName : "no repo bound · workspace-local"}
                        {p.archived ? " · archived" : ""}
                      </p>
                    </div>
                    <div className="hidden items-center gap-6 text-xs text-fg-muted sm:flex">
                      <span>{new Date(p.createdAt).toLocaleDateString()}</span>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs uppercase tracking-[0.1em] text-fg-subtle">
              {count} {count === 1 ? "project" : "projects"} · bind a Git repo to enable PRs
            </p>
          </>
        ) : (
          <EmptyState
            title="No projects yet"
            description="Create your first project to start a session."
            action={
              <Button onClick={() => setShowNew(true)} className="btn-primary px-3 py-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" aria-hidden /> New project
              </Button>
            }
          />
        )}

        {showNew ? <NewProjectDialog org={org} onClose={() => setShowNew(false)} /> : null}
      </div>
    </div>
  );
}

/** Modal for creating a project, with an optional GitHub repository binding. */
function NewProjectDialog({ org, onClose }: { org: string; onClose: () => void }) {
  const create = useCreateProject(org);
  const installs = useInstallations(org);
  const toast = useToast();
  const [name, setName] = React.useState("");
  const [installationId, setInstallationId] = React.useState<number | "">("");
  const [repoFullName, setRepoFullName] = React.useState("");
  const nameRef = React.useRef<HTMLInputElement>(null);

  // Focus the name field on open and close on Escape (modal conventions).
  React.useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = installs.data?.find((i) => i.installationId === installationId);
  const repo = selected?.repos.find((r) => r.fullName === repoFullName);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(
      {
        name: n,
        repo:
          installationId !== "" && repoFullName
            ? {
                installationId,
                repoFullName,
                defaultBranch: repo?.defaultBranch,
              }
            : undefined,
      },
      {
        onSuccess: (result) => {
          // The project was created either way; if only the repo bind failed,
          // keep the project and tell the user they can bind it from settings.
          if (result.bindError) {
            toast(
              `Project created, but repository binding failed: ${result.bindError.message}. You can bind it in project settings.`,
            );
          }
          onClose();
        },
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      data-testid="new-project-dialog"
      onMouseDown={(e) => {
        // Close when the backdrop (not the card) is clicked.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-md p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">New project</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-fg-muted hover:bg-panel focus-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="new-project-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="new-project-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              aria-label="Project name"
            />
          </div>

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Github className="h-4 w-4 text-fg-muted" aria-hidden /> GitHub repository
              <span className="font-normal text-fg-subtle">(optional)</span>
            </p>
            <p className="text-xs text-fg-muted">
              Bind a repository to let the agent work on real code, or leave it unbound to start
              with an empty workspace.
            </p>
            {installs.isLoading ? (
              <Loading label="Loading installations…" />
            ) : installs.isError ? (
              <p className="text-xs text-danger">
                Couldn&apos;t load GitHub installations. You can create the project now and bind a
                repository later from project settings.
              </p>
            ) : installs.data && installs.data.length > 0 ? (
              <>
                <select
                  value={installationId}
                  aria-label="GitHub installation"
                  onChange={(e) => {
                    setInstallationId(e.target.value ? Number(e.target.value) : "");
                    setRepoFullName("");
                  }}
                  className="h-9 w-full border border-line bg-transparent px-2 text-sm text-fg focus-ring"
                >
                  <option value="">No repository (unbound workspace)</option>
                  {installs.data.map((i) => (
                    <option key={i.installationId} value={i.installationId}>
                      {i.accountLogin}
                    </option>
                  ))}
                </select>
                <select
                  value={repoFullName}
                  aria-label="Repository"
                  disabled={!selected}
                  onChange={(e) => setRepoFullName(e.target.value)}
                  className="h-9 w-full border border-line bg-transparent px-2 text-sm text-fg focus-ring disabled:opacity-50"
                >
                  <option value="">Select repository…</option>
                  {selected?.repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                      {r.private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
                {repo ? (
                  <p className="text-xs text-fg-muted">
                    Default branch: <span className="font-mono">{repo.defaultBranch}</span>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-fg-subtle">
                No GitHub installations available.{" "}
                <Link to={`/${org}/settings`} className="underline" onClick={onClose}>
                  Connect GitHub
                </Link>{" "}
                to bind a repository.
              </p>
            )}
          </div>

          {create.isError ? (
            <p className="text-sm text-danger">{(create.error as Error).message}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              Create
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
