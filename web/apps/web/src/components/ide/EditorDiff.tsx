import * as React from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { MergeView } from "@codemirror/merge";
import { useFile, useDiff } from "../../api/queries";
import { Loading, ErrorState, EmptyState } from "../primitives";

const baseExtensions = (): Extension[] => [
  lineNumbers(),
  highlightActiveLine(),
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  EditorView.lineWrapping,
  javascript({ jsx: true, typescript: true }),
];

/** Read-only single-file CodeMirror view. */
function ReadView({ doc }: { doc: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const parent = ref.current;
    if (!parent) return;
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: baseExtensions() }),
      parent,
    });
    return () => view.destroy();
  }, [doc]);
  return <div ref={ref} className="h-full overflow-auto text-sm" data-testid="cm-read" />;
}

/** Side-by-side diff (working copy vs base branch) via @codemirror/merge. */
function DiffView({ before, after }: { before: string; after: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const parent = ref.current;
    if (!parent) return;
    const view = new MergeView({
      a: { doc: before, extensions: [...baseExtensions(), EditorView.editable.of(false)] },
      b: { doc: after, extensions: [...baseExtensions(), EditorView.editable.of(false)] },
      parent,
    });
    return () => view.destroy();
  }, [before, after]);
  return <div ref={ref} className="h-full overflow-auto text-sm" data-testid="cm-diff" />;
}

/**
 * EditorDiff — shows the selected file's contents (read view) or, when the agent
 * has modified it, a diff vs the working copy's base branch (Req 9). It
 * live-refreshes when `file_changed` bumps `refreshToken`. Large/binary files
 * fall back to a placeholder rather than freezing the UI (Req 9.4).
 */
export function EditorDiff({
  sessionId,
  path,
  mode,
  refreshToken,
}: {
  sessionId: string;
  path: string | null;
  mode: "file" | "diff";
  refreshToken?: number;
}) {
  const file = useFile(sessionId, mode === "file" ? path : null);
  const diff = useDiff(sessionId, mode === "diff" ? path : null);

  // Invalidate on file_changed.
  const qVersionRef = React.useRef(refreshToken);
  React.useEffect(() => {
    if (refreshToken !== qVersionRef.current) {
      qVersionRef.current = refreshToken;
      if (mode === "file") void file.refetch();
      else void diff.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  if (!path) {
    return <EmptyState title="No file selected" description="Pick a file from the tree to view it." />;
  }

  if (mode === "diff") {
    if (diff.isLoading) return <Loading label="Loading diff…" />;
    if (diff.isError) return <ErrorState message={(diff.error as Error)?.message} onRetry={() => diff.refetch()} />;
    if (!diff.data) return null;
    return (
      <div className="h-full" key={path}>
        <DiffView before={diff.data.before} after={diff.data.after} />
      </div>
    );
  }

  if (file.isLoading) return <Loading label="Loading file…" />;
  if (file.isError) return <ErrorState message={(file.error as Error)?.message} onRetry={() => file.refetch()} />;
  if (!file.data) return null;

  if (file.data.binary) {
    return <EmptyState title="Binary file" description={`${path} cannot be displayed.`} />;
  }

  return (
    <div className="h-full" key={path}>
      {file.data.truncated ? (
        <div className="border-b border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          File truncated — showing a partial view.
        </div>
      ) : null}
      <ReadView doc={file.data.content} />
    </div>
  );
}
