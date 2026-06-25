import * as React from "react";
import type { TreeEntry, GitStatus } from "@carrier/contract";
import { cn } from "@carrier/ui";
import { ChevronRight, ChevronDown, File, Folder } from "lucide-react";
import { api } from "../../api/client";
import { Loading, ErrorState } from "../primitives";

const INDENT_STEP = 12; // px per depth level (spacing-3)
const ROW_PAD = 4; // base left pad (spacing-1)
const TEXT_PAD = 8; // left pad for text-only rows (spacing-2)
const ICON_GUTTER = 18; // chevron width reserved for file rows

const gitColor: Record<GitStatus, string> = {
  A: "text-green-600 dark:text-green-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-600 dark:text-red-400 line-through",
  U: "text-violet-600 dark:text-violet-400",
  clean: "",
};

const gitBadge: Record<GitStatus, string> = {
  A: "A",
  M: "M",
  D: "D",
  U: "U",
  clean: "",
};

const gitTitle: Record<GitStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  U: "Untracked",
  clean: "",
};

interface DirState {
  loading: boolean;
  error: string | null;
  entries: TreeEntry[] | null;
}

/**
 * FileTree — lazily-loaded, collapsible tree of the session working copy with
 * git-status badges (Req 8). Selecting a file opens it in the editor. A
 * `refreshToken` change (bumped on `file_changed` stream events) re-fetches
 * any expanded directories so the tree stays near-real-time.
 */
export function FileTree({
  sessionId,
  selectedPath,
  onSelect,
  refreshToken,
}: {
  sessionId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  refreshToken?: number;
}) {
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [dirs, setDirs] = React.useState<Record<string, DirState>>({});

  const load = React.useCallback(
    async (path: string) => {
      setDirs((d) => ({ ...d, [path]: { loading: true, error: null, entries: d[path]?.entries ?? null } }));
      try {
        const entries = await api.tree(sessionId, path);
        setDirs((d) => ({ ...d, [path]: { loading: false, error: null, entries } }));
      } catch (e) {
        setDirs((d) => ({
          ...d,
          [path]: { loading: false, error: (e as Error).message, entries: d[path]?.entries ?? null },
        }));
      }
    },
    [sessionId],
  );

  // Load root on mount / session change.
  React.useEffect(() => {
    setOpen(new Set());
    setDirs({});
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Refresh root + any expanded dirs when the agent changes files.
  React.useEffect(() => {
    if (refreshToken === undefined) return;
    void load("");
    open.forEach((p) => void load(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const toggle = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!dirs[path]?.entries) void load(path);
      }
      return next;
    });
  };

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const state = dirs[path];
    if (!state) return null;
    if (state.loading && !state.entries)
      return (
        <div style={{ paddingLeft: depth * INDENT_STEP + TEXT_PAD }} className="py-1 text-xs text-fg-muted">
          loading…
        </div>
      );
    if (state.error && !state.entries)
      return (
        <div style={{ paddingLeft: depth * INDENT_STEP + TEXT_PAD }} className="py-1 text-xs text-danger">
          {state.error}
        </div>
      );
    const entries = state.entries ?? [];
    // Dirs first, then files; alphabetical.
    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return sorted.map((entry) => {
      const git = entry.git;
      if (entry.type === "dir") {
        const isOpen = open.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => toggle(entry.path)}
              style={{ paddingLeft: depth * INDENT_STEP + ROW_PAD }}
              className="flex w-full items-center gap-1 py-1 pr-2 text-left text-sm hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:hover:bg-neutral-800"
              aria-expanded={isOpen}
            >
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
              )}
              <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" aria-hidden />
              <span className="truncate">{entry.name}</span>
            </button>
            {isOpen ? renderDir(entry.path, depth + 1) : null}
          </div>
        );
      }
      const selected = selectedPath === entry.path;
      return (
        <button
          key={entry.path}
          type="button"
          onClick={() => onSelect(entry.path)}
          style={{ paddingLeft: depth * INDENT_STEP + ROW_PAD + ICON_GUTTER }}
          className={cn(
            "flex w-full items-center gap-1 py-1 pr-2 text-left text-sm hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:hover:bg-neutral-800",
            selected && "bg-blue-50 dark:bg-blue-950/40",
          )}
          aria-current={selected ? "true" : undefined}
        >
          <File className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
          <span className={cn("truncate", git && gitColor[git])}>{entry.name}</span>
          {git && git !== "clean" ? (
            <span
              className={cn("ml-auto text-3xs font-bold", gitColor[git])}
              title={gitTitle[git]}
            >
              {gitBadge[git]}
            </span>
          ) : null}
        </button>
      );
    });
  };

  const root = dirs[""];
  if (!root) return <Loading label="Loading files…" />;
  if (root.error && !root.entries)
    return <ErrorState message={root.error} onRetry={() => void load("")} />;

  return (
    <div className="h-full overflow-auto py-1" role="tree" aria-label="File tree">
      {renderDir("", 0)}
    </div>
  );
}
