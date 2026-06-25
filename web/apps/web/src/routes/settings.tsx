import * as React from "react";
import { useParams, useRouteLoaderData, Link, useNavigate } from "react-router";
import type { Me, Org, Role } from "@carrier/contract";
import { Button } from "@carrier/ui";
import { Plus, UserPlus, Github, Loader2 } from "lucide-react";
import { Card, EmptyState, Loading, ErrorState, Input } from "../components/primitives";
import { ConfigSection, DeleteButton } from "../components/config-controls";
import { useToast } from "../components/toast";
import {
  usePermissions,
  useProject,
  useAddPermission,
  useDeletePermission,
  useMembers,
  useAddMember,
  useRemoveMember,
  useInstallations,
  useBindRepo,
  useUnbindRepo,
  useArchiveProject,
  useProjectUsage,
} from "../api/queries";
import { formatUsd, formatTokens } from "../components/ide/UsagePanel";
import { ConfigSections } from "./config-sections";
import { InstalledPluginsSection } from "./marketplace";

/** Roles that may manage org members / project settings. */
function canManage(role?: Role): boolean {
  return role === "owner" || role === "admin";
}

// ─── Org settings: members + installations (Req 17/21) ───────────────────────

export function OrgSettingsPage() {
  const { org = "" } = useParams();
  const me = useRouteLoaderData("root") as Me | undefined;
  const current = me?.orgs.find((o) => o.slug === org);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 text-sm text-fg-muted">
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
            <dt className="text-fg-muted">Name</dt>
            <dd>{current?.name ?? org}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Kind</dt>
            <dd>{current?.kind ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Your role</dt>
            <dd>{current?.role ?? "—"}</dd>
          </div>
        </dl>
      </Card>

      <MembersSection orgSlug={org} current={current} />
      <InstallationsSection orgSlug={org} />

      <h2 className="mb-4 mt-8 text-lg font-semibold">Configuration</h2>
      <ConfigSections scope="org" ownerKey={org} manage={canManage(current?.role)} />
      <InstalledPluginsSection scope="org" ownerKey={org} manage={canManage(current?.role)} />
    </div>
  );
}

function MembersSection({ orgSlug, current }: { orgSlug: string; current?: Org }) {
  const toast = useToast();
  const manage = canManage(current?.role);
  const members = useMembers(orgSlug);
  const addMember = useAddMember(orgSlug);
  const removeMember = useRemoveMember(orgSlug);

  const [login, setLogin] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const l = login.trim();
    if (!l) return;
    addMember.mutate(
      { login: l, role },
      {
        onSuccess: () => {
          setLogin("");
          toast("Member added");
        },
      },
    );
  };

  return (
    <ConfigSection
      title="Members"
      testId="members-section"
      query={members}
      emptyState={<EmptyState title="No members" description="Add a member by their GitHub login." />}
      form={
        <>
          {manage ? (
            <form onSubmit={submit} className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="GitHub login"
                aria-label="Member login"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                aria-label="Member role"
                className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm focus-ring dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </select>
              <Button type="submit" disabled={!login.trim() || addMember.isPending} className="shrink-0">
                <UserPlus className="h-4 w-4" aria-hidden /> Add
              </Button>
            </form>
          ) : null}
          {addMember.isError ? (
            <p className="mb-2 text-sm text-danger">{(addMember.error as Error).message}</p>
          ) : null}
        </>
      }
      renderItem={(m) => (
        <li key={m.accountId || m.login} className="flex items-center gap-2 py-2">
          <span className="flex-1 truncate font-medium">{m.login}</span>
          <span className="text-xs text-fg-muted">{m.role}</span>
          {manage ? (
            <DeleteButton
              label={`Remove ${m.login}`}
              disabled={removeMember.isPending}
              onClick={() =>
                removeMember.mutate(m.accountId || m.login, {
                  onSuccess: () => toast("Removed"),
                })
              }
            />
          ) : null}
        </li>
      )}
    />
  );
}

function InstallationsSection({ orgSlug }: { orgSlug: string }) {
  const installs = useInstallations(orgSlug);
  return (
    <Card className="p-4" data-testid="installations-section">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <Github className="h-4 w-4" aria-hidden /> GitHub App installations
      </h2>
      {installs.isLoading ? (
        <Loading />
      ) : installs.isError ? (
        <ErrorState message={(installs.error as Error).message} onRetry={() => installs.refetch()} />
      ) : installs.data && installs.data.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {installs.data.map((i) => (
            <li key={i.installationId} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
              <p className="font-medium">{i.accountLogin}</p>
              <p className="text-xs text-fg-muted">
                {i.repos.length} repo{i.repos.length === 1 ? "" : "s"} · installation #{i.installationId}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No installations"
          description="Install the Carrier GitHub App to grant repository access."
        />
      )}
    </Card>
  );
}

// ─── Project settings: repo binding, permissions, danger zone (Req 18/21) ────

export function ProjectSettingsPage() {
  const { org = "", project = "" } = useParams();
  const me = useRouteLoaderData("root") as Me | undefined;
  const projectQ = useProject(project);
  const currentOrg = me?.orgs.find((o) => o.id === projectQ.data?.orgId) ?? me?.orgs.find((o) => o.slug === org);
  const manage = canManage(currentOrg?.role);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 text-sm text-fg-muted">
        <Link to={`/${org}/${project}`} className="hover:underline">
          {projectQ.data?.name ?? project}
        </Link>{" "}
        / <span className="text-neutral-800 dark:text-neutral-100">Settings</span>
      </div>
      <h1 className="mb-4 text-lg font-semibold">Project settings</h1>

      <RepoBindingSection orgSlug={currentOrg?.slug ?? org} projectId={project} manage={manage} />

      <h2 className="mb-4 mt-8 text-lg font-semibold">Configuration</h2>
      <ConfigSections scope="project" ownerKey={project} manage={manage} />
      <InstalledPluginsSection scope="project" ownerKey={project} manage={manage} />
      <PermissionsSection projectId={project} manage={manage} />

      <UsageSection projectId={project} />
      <DangerZone orgSlug={org} projectId={project} manage={manage} />
    </div>
  );
}

function RepoBindingSection({ orgSlug, projectId, manage }: { orgSlug: string; projectId: string; manage: boolean }) {
  const toast = useToast();
  const projectQ = useProject(projectId);
  const installs = useInstallations(orgSlug);
  const bind = useBindRepo(projectId);
  const unbind = useUnbindRepo(projectId);

  const [installationId, setInstallationId] = React.useState<number | "">("");
  const [repoFullName, setRepoFullName] = React.useState("");
  const [branch, setBranch] = React.useState("");

  const selected = installs.data?.find((i) => i.installationId === installationId);
  const selectedRepo = selected?.repos.find((r) => r.fullName === repoFullName);

  // Default the branch to the repo's default when a repo is picked.
  React.useEffect(() => {
    if (selectedRepo) setBranch((b) => b || selectedRepo.defaultBranch);
  }, [selectedRepo]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (installationId === "" || !repoFullName) return;
    bind.mutate(
      {
        installationId: Number(installationId),
        repoFullName,
        defaultBranch: branch.trim() || undefined,
      },
      { onSuccess: () => toast("Repository bound") },
    );
  };

  return (
    <Card className="mb-4 p-4" data-testid="repo-binding-section">
      <h2 className="mb-2 text-sm font-medium">Repository binding</h2>
      {projectQ.isLoading ? (
        <Loading />
      ) : projectQ.data?.repo ? (
        <div className="space-y-2 text-sm">
          <p>
            Bound to <span className="font-mono">{projectQ.data.repo.repoFullName}</span> (
            {projectQ.data.repo.defaultBranch})
          </p>
          {manage ? (
            <Button
              variant="outline"
              size="sm"
              disabled={unbind.isPending}
              onClick={() => unbind.mutate(undefined, { onSuccess: () => toast("Repository unbound") })}
            >
              Unbind
            </Button>
          ) : null}
          {unbind.isError ? (
            <p className="text-sm text-danger">{(unbind.error as Error).message}</p>
          ) : null}
        </div>
      ) : !manage ? (
        <p className="text-sm text-fg-muted">Unbound. Ask an admin to bind a repository.</p>
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <p className="text-sm text-fg-muted">
            Bind a repository to let the agent work on real code.
          </p>
          {installs.isLoading ? (
            <Loading />
          ) : (
            <>
              <select
                value={installationId}
                aria-label="Installation"
                onChange={(e) => {
                  setInstallationId(e.target.value ? Number(e.target.value) : "");
                  setRepoFullName("");
                  setBranch("");
                }}
                className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm focus-ring dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="">Select installation…</option>
                {installs.data?.map((i) => (
                  <option key={i.installationId} value={i.installationId}>
                    {i.accountLogin}
                  </option>
                ))}
              </select>
              <select
                value={repoFullName}
                aria-label="Repository"
                disabled={!selected}
                onChange={(e) => {
                  setRepoFullName(e.target.value);
                  setBranch("");
                }}
                className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm focus-ring disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="">Select repository…</option>
                {selected?.repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
              <Input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="Default branch"
                aria-label="Default branch"
              />
              <Button type="submit" disabled={installationId === "" || !repoFullName || bind.isPending}>
                {bind.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                Bind repository
              </Button>
            </>
          )}
          {bind.isError ? (
            <p className="text-sm text-danger">{(bind.error as Error).message}</p>
          ) : null}
        </form>
      )}
    </Card>
  );
}

const ACTIONS = ["read", "write", "execute", "network", "*"];

function PermissionsSection({ projectId, manage }: { projectId: string; manage: boolean }) {
  const toast = useToast();
  const perms = usePermissions(projectId);
  const add = useAddPermission(projectId);
  const del = useDeletePermission(projectId);

  const [action, setAction] = React.useState("write");
  const [pattern, setPattern] = React.useState("");
  const [effect, setEffect] = React.useState<"allow" | "deny" | "ask">("ask");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = pattern.trim();
    if (!p) return;
    add.mutate(
      { action, pattern: p, effect },
      {
        onSuccess: () => {
          setPattern("");
          toast("Rule added");
        },
      },
    );
  };

  return (
    <Card className="mb-4 p-4" data-testid="permissions-section">
      <h2 className="mb-2 text-sm font-medium">Permission rules</h2>

      {manage ? (
        <form onSubmit={submit} className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            aria-label="Rule action"
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm focus-ring dark:border-neutral-700 dark:bg-neutral-950"
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Resource pattern (e.g. **/*.ts)"
            aria-label="Resource pattern"
          />
          <select
            value={effect}
            onChange={(e) => setEffect(e.target.value as "allow" | "deny" | "ask")}
            aria-label="Rule effect"
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm focus-ring dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
            <option value="ask">ask</option>
          </select>
          <Button type="submit" disabled={!pattern.trim() || add.isPending} className="shrink-0">
            <Plus className="h-4 w-4" aria-hidden /> Add
          </Button>
        </form>
      ) : null}
      {add.isError ? (
        <p className="mb-2 text-sm text-danger">{(add.error as Error).message}</p>
      ) : null}

      {perms.isLoading ? (
        <Loading />
      ) : perms.isError ? (
        <ErrorState message={(perms.error as Error).message} onRetry={() => perms.refetch()} />
      ) : perms.data && perms.data.length > 0 ? (
        <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {perms.data.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-1.5">
              <span className="w-16 font-mono text-xs">{r.action}</span>
              <span className="flex-1 truncate font-mono text-xs text-fg-muted">{r.pattern}</span>
              <span
                className={
                  r.effect === "deny"
                    ? "text-danger"
                    : r.effect === "allow"
                      ? "text-success"
                      : "text-warning"
                }
              >
                {r.effect}
              </span>
              {manage ? (
                <DeleteButton
                  label={`Delete rule ${r.action} ${r.pattern}`}
                  disabled={del.isPending}
                  onClick={() => del.mutate(r.id, { onSuccess: () => toast("Removed") })}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">No rules configured (defaults apply).</p>
      )}
    </Card>
  );
}

function UsageSection({ projectId }: { projectId: string }) {
  const usage = useProjectUsage(projectId, { retry: false });
  if (usage.isError || (!usage.isLoading && !usage.data)) return null;
  return (
    <Card className="mb-4 p-4" data-testid="project-usage-section">
      <h2 className="mb-2 text-sm font-medium">Usage</h2>
      {usage.isLoading ? (
        <Loading />
      ) : usage.data ? (
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-fg-muted">Tokens</dt>
            <dd className="font-mono">
              {formatTokens(usage.data.inputTokens + usage.data.outputTokens)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Cost</dt>
            <dd className="font-mono">{formatUsd(usage.data.costUsd)}</dd>
          </div>
        </dl>
      ) : null}
    </Card>
  );
}

function DangerZone({
  orgSlug,
  projectId,
  manage,
}: {
  orgSlug: string;
  projectId: string;
  manage: boolean;
}) {
  const navigate = useNavigate();
  const projectQ = useProject(projectId);
  const archive = useArchiveProject(projectId);
  const [confirming, setConfirming] = React.useState(false);
  const archived = projectQ.data?.archived;

  const doArchive = () => {
    archive.mutate(undefined, {
      onSuccess: () => navigate(`/${orgSlug}`),
    });
  };

  return (
    <Card className="border-red-300 p-4 dark:border-red-900">
      <h2 className="mb-2 text-sm font-medium text-danger">Danger zone</h2>
      <p className="mb-2 text-sm text-fg-muted">
        Archiving a project stops new sessions while preserving its workspace and history.
      </p>
      {archived ? (
        <p className="text-sm text-fg-muted">This project is archived.</p>
      ) : !manage ? (
        <p className="text-sm text-fg-muted">Only owners and admins can archive a project.</p>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-danger text-danger"
            disabled={archive.isPending}
            onClick={doArchive}
          >
            {archive.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            Confirm archive
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="border-danger text-danger"
          onClick={() => setConfirming(true)}
        >
          Archive project
        </Button>
      )}
      {archive.isError ? (
        <p className="mt-2 text-sm text-danger">{(archive.error as Error).message}</p>
      ) : null}
    </Card>
  );
}
