import * as React from "react";
import { Link, useParams } from "react-router";
import { Button } from "@carrier/ui";
import { Plus, FolderGit2, Settings } from "lucide-react";
import { useProjects, useCreateProject } from "../api/queries";
import { Card, Input, Loading, ErrorState, EmptyState } from "../components/primitives";

/** /:org — project list within an org/personal context (Req 4). */
export function OrgPage() {
  const { org = "" } = useParams();
  const projects = useProjects(org);
  const create = useCreateProject(org);
  const [name, setName] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(n, { onSuccess: () => setName("") });
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Link
          to={`/${org}/settings`}
          className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:underline"
        >
          <Settings className="h-4 w-4" aria-hidden /> Org settings
        </Link>
      </div>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          aria-label="New project name"
        />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          <Plus className="h-4 w-4" aria-hidden /> Create
        </Button>
      </form>
      {create.isError ? (
        <p className="mb-3 text-sm text-red-500">{(create.error as Error).message}</p>
      ) : null}

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
                  <FolderGit2 className="h-5 w-5 text-blue-500" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-neutral-500">
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
        />
      )}
    </div>
  );
}
