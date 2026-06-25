import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  api,
  type Member,
  type Installation,
  type ConfigKind,
  type ConfigKindMap,
  type PluginVersionDetail,
} from "./client";
import type {
  Me,
  Org,
  Project,
  Session,
  TreeEntry,
  FileContent,
  FileDiff,
  Usage,
  PermissionRule,
  ConfigScope,
  ModelParams,
  MarketplacePlugin,
  PluginVersion,
  PluginInstall,
  InstallPlugin,
} from "@carrier/contract";

/** Centralized query keys so invalidation stays consistent. */
export const qk = {
  me: ["me"] as const,
  orgs: ["orgs"] as const,
  projects: (org: string) => ["projects", org] as const,
  project: (id: string) => ["project", id] as const,
  sessions: (projectId: string) => ["sessions", projectId] as const,
  session: (id: string) => ["session", id] as const,
  tree: (sessionId: string, path: string) => ["tree", sessionId, path] as const,
  file: (sessionId: string, path: string) => ["file", sessionId, path] as const,
  diff: (sessionId: string, path: string) => ["diff", sessionId, path] as const,
  permissions: (projectId: string) => ["permissions", projectId] as const,
  members: (org: string) => ["members", org] as const,
  installations: (org: string) => ["installations", org] as const,
  sessionUsage: (id: string) => ["usage", "session", id] as const,
  projectUsage: (id: string) => ["usage", "project", id] as const,
  config: (scope: ConfigScope, owner: string, kind: ConfigKind) =>
    ["config", scope, owner, kind] as const,
  modelParams: (scope: ConfigScope, owner: string) =>
    ["config", scope, owner, "model"] as const,
  marketplaceSearch: (q: string) => ["marketplace", "search", q] as const,
  pluginVersions: (name: string) => ["marketplace", "versions", name] as const,
  pluginVersion: (name: string, version: string) =>
    ["marketplace", "version", name, version] as const,
  installedPlugins: (scope: ConfigScope, owner: string) =>
    ["plugins", scope, owner] as const,
};

export function useMe(opts?: Partial<UseQueryOptions<Me>>) {
  return useQuery({ queryKey: qk.me, queryFn: ({ signal }) => api.me(signal), ...opts });
}

export function useOrgs(opts?: Partial<UseQueryOptions<Org[]>>) {
  return useQuery({ queryKey: qk.orgs, queryFn: ({ signal }) => api.orgs(signal), ...opts });
}

export function useProjects(orgSlug: string, opts?: Partial<UseQueryOptions<Project[]>>) {
  return useQuery({
    queryKey: qk.projects(orgSlug),
    queryFn: ({ signal }) => api.projects(orgSlug, signal),
    ...opts,
  });
}

export function useProject(projectId: string, opts?: Partial<UseQueryOptions<Project>>) {
  return useQuery({
    queryKey: qk.project(projectId),
    queryFn: ({ signal }) => api.project(projectId, signal),
    ...opts,
  });
}

export function useSessions(projectId: string, opts?: Partial<UseQueryOptions<Session[]>>) {
  return useQuery({
    queryKey: qk.sessions(projectId),
    queryFn: ({ signal }) => api.sessions(projectId, signal),
    ...opts,
  });
}

export function useSession(sessionId: string, opts?: Partial<UseQueryOptions<Session>>) {
  return useQuery({
    queryKey: qk.session(sessionId),
    queryFn: ({ signal }) => api.session(sessionId, signal),
    ...opts,
  });
}

export function useTree(
  sessionId: string,
  path: string,
  opts?: Partial<UseQueryOptions<TreeEntry[]>>,
) {
  return useQuery({
    queryKey: qk.tree(sessionId, path),
    queryFn: ({ signal }) => api.tree(sessionId, path, signal),
    ...opts,
  });
}

export function useFile(
  sessionId: string,
  path: string | null,
  opts?: Partial<UseQueryOptions<FileContent>>,
) {
  return useQuery({
    queryKey: qk.file(sessionId, path ?? ""),
    queryFn: ({ signal }) => api.file(sessionId, path as string, signal),
    enabled: !!path,
    ...opts,
  });
}

export function useDiff(
  sessionId: string,
  path: string | null,
  opts?: Partial<UseQueryOptions<FileDiff>>,
) {
  return useQuery({
    queryKey: qk.diff(sessionId, path ?? ""),
    queryFn: ({ signal }) => api.diff(sessionId, path as string, signal),
    enabled: !!path,
    ...opts,
  });
}

export function usePermissions(projectId: string) {
  return useQuery({
    queryKey: qk.permissions(projectId),
    queryFn: ({ signal }) => api.permissions(projectId, signal),
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────

export function useCreateProject(orgSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Create the project, then optionally bind a GitHub repo in the same flow so
    // the dialog can offer repo selection at creation time (repo is optional).
    // The project is created first: if the subsequent bind fails we keep the
    // project (it already exists server-side) and surface the bind error to the
    // caller via `bindError` rather than throwing — otherwise onSuccess would
    // not fire, the projects list would never refresh, and the just-created
    // project would be stranded/hidden behind an error.
    mutationFn: async (vars: {
      name: string;
      repo?: { installationId: number; repoFullName: string; defaultBranch?: string };
    }): Promise<{ project: Project; bindError?: Error }> => {
      const project = await api.createProject(orgSlug, vars.name);
      if (!vars.repo) return { project };
      try {
        const bound = await api.bindRepo(project.id, vars.repo);
        return { project: bound };
      } catch (err) {
        return { project, bindError: err as Error };
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects(orgSlug) }),
  });
}

export function useCreateSession(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { title?: string; planMode?: boolean }) =>
      api.createSession(projectId, opts),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions(projectId) }),
  });
}

export function usePromote(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.promote(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.session(sessionId) }),
  });
}

// ── Permissions (add/delete — Req 18) ────────────────────────────────────────

export function useAddPermission(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rule: { action: string; pattern: string; effect: "allow" | "deny" | "ask" }) =>
      api.addPermission(projectId, rule),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.permissions(projectId) }),
  });
}

export function useDeletePermission(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) => api.deletePermission(projectId, ruleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.permissions(projectId) }),
  });
}

// ── Members (Req 21) ─────────────────────────────────────────────────────────

export function useMembers(orgSlug: string, opts?: Partial<UseQueryOptions<Member[]>>) {
  return useQuery({
    queryKey: qk.members(orgSlug),
    queryFn: ({ signal }) => api.members(orgSlug, signal),
    ...opts,
  });
}

export function useAddMember(orgSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (member: { login: string; role: "owner" | "admin" | "member" }) =>
      api.addMember(orgSlug, member),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(orgSlug) }),
  });
}

export function useRemoveMember(orgSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.removeMember(orgSlug, accountId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(orgSlug) }),
  });
}

// ── GitHub installations (Req 21) ────────────────────────────────────────────

export function useInstallations(
  org: string,
  opts?: Partial<UseQueryOptions<Installation[]>>,
) {
  return useQuery({
    queryKey: qk.installations(org),
    queryFn: ({ signal }) => api.installations(org, signal),
    enabled: !!org,
    ...opts,
  });
}

// ── Repo binding (Req 21) ────────────────────────────────────────────────────

export function useBindRepo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (binding: {
      installationId: number;
      repoFullName: string;
      defaultBranch?: string;
    }) => api.bindRepo(projectId, binding),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project(projectId) }),
  });
}

export function useUnbindRepo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.unbindRepo(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project(projectId) }),
  });
}

export function useArchiveProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.archiveProject(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project(projectId) }),
  });
}

// ── Usage (Req 20) ───────────────────────────────────────────────────────────

export function useSessionUsage(sessionId: string, opts?: Partial<UseQueryOptions<Usage>>) {
  return useQuery({
    queryKey: qk.sessionUsage(sessionId),
    queryFn: ({ signal }) => api.sessionUsage(sessionId, signal),
    ...opts,
  });
}

export function useProjectUsage(projectId: string, opts?: Partial<UseQueryOptions<Usage>>) {
  return useQuery({
    queryKey: qk.projectUsage(projectId),
    queryFn: ({ signal }) => api.projectUsage(projectId, signal),
    ...opts,
  });
}

// ── Configuration system (org + project scopes) ──────────────────────────────

export function useConfigList<K extends ConfigKind>(
  scope: ConfigScope,
  ownerKey: string,
  kind: K,
  opts?: Partial<UseQueryOptions<ConfigKindMap[K]["entity"][]>>,
) {
  return useQuery({
    queryKey: qk.config(scope, ownerKey, kind),
    queryFn: ({ signal }) => api.config.list(scope, ownerKey, kind, signal),
    enabled: !!ownerKey,
    ...opts,
  });
}

export function useCreateConfig<K extends ConfigKind>(
  scope: ConfigScope,
  ownerKey: string,
  kind: K,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConfigKindMap[K]["create"]) =>
      api.config.create(scope, ownerKey, kind, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.config(scope, ownerKey, kind) }),
  });
}

export function useUpdateConfig<K extends ConfigKind>(
  scope: ConfigScope,
  ownerKey: string,
  kind: K,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      patch: Partial<ConfigKindMap[K]["create"]> & { enabled?: boolean };
    }) => api.config.update(scope, ownerKey, kind, vars.id, vars.patch),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.config(scope, ownerKey, kind) }),
  });
}

export function useRemoveConfig<K extends ConfigKind>(
  scope: ConfigScope,
  ownerKey: string,
  kind: K,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.config.remove(scope, ownerKey, kind, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.config(scope, ownerKey, kind) }),
  });
}

export function useModelParams(
  scope: ConfigScope,
  ownerKey: string,
  opts?: Partial<UseQueryOptions<ModelParams>>,
) {
  return useQuery({
    queryKey: qk.modelParams(scope, ownerKey),
    queryFn: ({ signal }) => api.config.getModel(scope, ownerKey, signal),
    enabled: !!ownerKey,
    ...opts,
  });
}

export function usePutModelParams(scope: ConfigScope, ownerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: ModelParams) => api.config.putModel(scope, ownerKey, params),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.modelParams(scope, ownerKey) }),
  });
}

// ── Plugin marketplace (Req 4/5) ──────────────────────────────────────────────

export function useMarketplaceSearch(
  q: string,
  opts?: Partial<UseQueryOptions<MarketplacePlugin[]>>,
) {
  return useQuery({
    queryKey: qk.marketplaceSearch(q),
    queryFn: ({ signal }) => api.marketplace.search(q, signal),
    ...opts,
  });
}

export function usePluginVersions(
  name: string,
  opts?: Partial<UseQueryOptions<PluginVersion[]>>,
) {
  return useQuery({
    queryKey: qk.pluginVersions(name),
    queryFn: ({ signal }) => api.marketplace.versions(name, signal),
    enabled: !!name,
    ...opts,
  });
}

export function usePluginVersion(
  name: string,
  version: string | null,
  opts?: Partial<UseQueryOptions<PluginVersionDetail>>,
) {
  return useQuery({
    queryKey: qk.pluginVersion(name, version ?? ""),
    queryFn: ({ signal }) => api.marketplace.version(name, version as string, signal),
    enabled: !!name && !!version,
    ...opts,
  });
}

export function useInstalledPlugins(
  scope: ConfigScope,
  ownerKey: string,
  opts?: Partial<UseQueryOptions<PluginInstall[]>>,
) {
  return useQuery({
    queryKey: qk.installedPlugins(scope, ownerKey),
    queryFn: ({ signal }) => api.marketplace.listInstalls(scope, ownerKey, signal),
    enabled: !!ownerKey,
    ...opts,
  });
}

export function useInstallPlugin(scope: ConfigScope, ownerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InstallPlugin) => api.marketplace.install(scope, ownerKey, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.installedPlugins(scope, ownerKey) }),
  });
}

export function useUpdateInstall(scope: ConfigScope, ownerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: { enabled?: boolean; version?: string } }) =>
      api.marketplace.updateInstall(scope, ownerKey, vars.id, vars.patch),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.installedPlugins(scope, ownerKey) }),
  });
}

export function useUninstall(scope: ConfigScope, ownerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.marketplace.uninstall(scope, ownerKey, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.installedPlugins(scope, ownerKey) }),
  });
}

export type { PermissionRule };
