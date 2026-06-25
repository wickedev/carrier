import * as React from "react";
import { Link, useParams } from "react-router";
import { Button } from "@carrier/ui";
import { Plus, FolderGit2, Settings, Github, X, Loader2 } from "lucide-react";
import { useProjects, useCreateProject, useInstallations } from "../api/queries";
import { Card, Input, Loading, ErrorState, EmptyState } from "../components/primitives";
import { useToast } from "../components/toast";

/** /:org — project list within an org/personal context (Req 4). */
export function OrgPage() {
  const { org = "" } = useParams();
  const projects = useProjects(org);
  const [showNew, setShowNew] = React.useState(false);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Projects</h1>
        <div className="flex items-center gap-3">
          <Link
            to={`/${org}/settings`}
            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
          >
            <Settings className="h-4 w-4" aria-hidden /> Org settings
          </Link>
          <Button onClick={() => setShowNew(true)} data-testid="new-project-button">
            <Plus className="h-4 w-4" aria-hidden /> New project
          </Button>
        </div>
      </div>

      {projects.isLoading ? (
        <Loading />
      ) : projects.isError ? (
        <ErrorState message={(projects.error as Error).message} onRetry={() => projects.refetch()} />
      ) : projects.data && projects.data.length > 0 ? (
        <ul className="space-y-2">
          {projects.data.map((p) => (
            <li key={p.id}>
              <Link to={`/${org}/${p.id}`}>
                <Card className="flex items-center gap-3 p-3 transition-colors hover:border-neutral-300 dark:hover:border-neutral-700">
                  <FolderGit2 className="h-5 w-5 text-info" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-fg-muted">
                      {p.repo ? p.repo.repoFullName : "Unbound workspace"}
                      {p.archived ? " · archived" : ""}
                    </p>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No projects yet"
          description="Create your first project to start a session."
          action={
            <Button onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New project
            </Button>
          }
        />
      )}

      {showNew ? <NewProjectDialog org={org} onClose={() => setShowNew(false)} /> : null}
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
            className="rounded p-1 text-fg-muted hover:bg-neutral-100 focus-ring dark:hover:bg-neutral-800"
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
                  className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm focus-ring dark:border-neutral-700 dark:bg-neutral-950"
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
                  className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm focus-ring disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
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
