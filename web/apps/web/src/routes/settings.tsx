import { useParams, useRouteLoaderData, Link } from "react-router";
import type { Me } from "@carrier/contract";
import { Card, EmptyState, Loading, ErrorState } from "../components/primitives";
import { usePermissions, useProject } from "../api/queries";

/** /:org/settings — members & GitHub installations (Req 17). */
export function OrgSettingsPage() {
  const { org = "" } = useParams();
  const me = useRouteLoaderData("root") as Me | undefined;
  const current = me?.orgs.find((o) => o.slug === org);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 text-sm text-neutral-500">
        <Link to={`/${org}`} className="hover:underline">
          {org}
        </Link>{" "}
        / <span className="text-neutral-800 dark:text-neutral-100">Settings</span>
      </div>
      <h1 className="mb-4 text-lg font-semibold">Org settings</h1>

      <Card className="mb-4 p-4">
        <h2 className="mb-2 text-sm font-medium">Context</h2>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">Name</dt>
            <dd>{current?.name ?? org}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">Kind</dt>
            <dd>{current?.kind ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">Your role</dt>
            <dd>{current?.role ?? "—"}</dd>
          </div>
        </dl>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-medium">GitHub App installations</h2>
        <EmptyState
          title="Manage installations"
          description="Install the Carrier GitHub App to grant repository access. (Handled by the BFF.)"
        />
      </Card>
    </div>
  );
}

/** /:org/:project/settings — repo binding, permissions, danger zone (Req 17). */
export function ProjectSettingsPage() {
  const { org = "", project = "" } = useParams();
  const projectQ = useProject(project);
  const perms = usePermissions(project);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 text-sm text-neutral-500">
        <Link to={`/${org}/${project}`} className="hover:underline">
          {projectQ.data?.name ?? project}
        </Link>{" "}
        / <span className="text-neutral-800 dark:text-neutral-100">Settings</span>
      </div>
      <h1 className="mb-4 text-lg font-semibold">Project settings</h1>

      <Card className="mb-4 p-4">
        <h2 className="mb-2 text-sm font-medium">Repository binding</h2>
        {projectQ.isLoading ? (
          <Loading />
        ) : projectQ.data?.repo ? (
          <p className="text-sm">
            Bound to <span className="font-mono">{projectQ.data.repo.repoFullName}</span> (
            {projectQ.data.repo.defaultBranch})
          </p>
        ) : (
          <p className="text-sm text-neutral-500">
            Unbound. Bind a repository to let the agent work on real code.
          </p>
        )}
      </Card>

      <Card className="mb-4 p-4">
        <h2 className="mb-2 text-sm font-medium">Permission rules</h2>
        {perms.isLoading ? (
          <Loading />
        ) : perms.isError ? (
          <ErrorState message={(perms.error as Error).message} onRetry={() => perms.refetch()} />
        ) : perms.data && perms.data.length > 0 ? (
          <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
            {perms.data.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-1.5">
                <span className="w-16 font-mono text-xs">{r.action}</span>
                <span className="flex-1 truncate font-mono text-xs text-neutral-500">
                  {r.pattern}
                </span>
                <span
                  className={
                    r.effect === "deny"
                      ? "text-red-500"
                      : r.effect === "allow"
                        ? "text-green-600 dark:text-green-400"
                        : "text-amber-500"
                  }
                >
                  {r.effect}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">No rules configured (defaults apply).</p>
        )}
      </Card>

      <Card className="border-red-300 p-4 dark:border-red-900">
        <h2 className="mb-2 text-sm font-medium text-red-600 dark:text-red-400">Danger zone</h2>
        <p className="text-sm text-neutral-500">
          Archiving a project stops new sessions while preserving its workspace and history.
        </p>
      </Card>
    </div>
  );
}
