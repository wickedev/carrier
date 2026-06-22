import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { api } from "./client";
import type { Me, Org, Project, Session, TreeEntry, FileContent, FileDiff } from "@carrier/contract";

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
    mutationFn: (name: string) => api.createProject(orgSlug, name),
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
