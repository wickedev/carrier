import * as React from "react";
import { useParams } from "react-router";
import { useStore } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { Files, GitCompareArrows } from "lucide-react";
import { cn } from "@carrier/ui";

import { api, eventsUrl } from "../api/client";
import { useSession, qk } from "../api/queries";
import {
  useSessionStream,
  connectSessionStream,
} from "../session/stream";
import { IdeLayout } from "../components/ide/IdeLayout";
import { FileTree } from "../components/ide/FileTree";
import { EditorDiff } from "../components/ide/EditorDiff";
import { AgentPanel } from "../components/ide/AgentPanel";
import { TopBar } from "../components/ide/TopBar";
import { ErrorBoundary } from "../components/ErrorBoundary";

/** /:org/:project/s/:session — the IDE split-view (Req 8–11). */
export function SessionPage() {
  const { org = "", project = "", session: sessionId = "" } = useParams();
  const qc = useQueryClient();
  const sessionQ = useSession(sessionId);

  const stream = useSessionStream;
  const events = useStore(stream, (s) => s.events);
  const status = useStore(stream, (s) => s.status);
  const approvals = useStore(stream, (s) => s.pendingApprovals);
  const connection = useStore(stream, (s) => s.connection);

  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"file" | "diff">("file");
  const [fileRefreshToken, setFileRefreshToken] = React.useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [deciding, setDeciding] = React.useState<string | null>(null);
  const [prUrl, setPrUrl] = React.useState<string | null>(null);
  const [promoting, setPromoting] = React.useState(false);

  // Reset + connect the stream when the session changes.
  React.useEffect(() => {
    stream.getState().reset(sessionId);
    const dispose = connectSessionStream(eventsUrl(sessionId), { store: stream });
    return dispose;
  }, [sessionId, stream]);

  // React to file_changed events: refresh tree always; refresh the editor when
  // the open file is the one that changed.
  const lastSeq = React.useRef<number>(-1);
  React.useEffect(() => {
    for (const e of events) {
      if (e.seq <= lastSeq.current) continue;
      lastSeq.current = e.seq;
      if (e.kind === "file_changed") {
        setTreeRefreshToken((t) => t + 1);
        if (e.path === selectedPath) {
          setFileRefreshToken((t) => t + 1);
          // also invalidate Query cache for that file/diff
          void qc.invalidateQueries({ queryKey: qk.file(sessionId, e.path) });
          void qc.invalidateQueries({ queryKey: qk.diff(sessionId, e.path) });
        }
      }
    }
  }, [events, selectedPath, sessionId, qc]);

  const onSend = async (text: string, steer: boolean) => {
    setSending(true);
    try {
      await api.sendInput(sessionId, text, steer);
    } finally {
      setSending(false);
    }
  };

  const onInterrupt = () => void api.interrupt(sessionId);

  const onDecide = async (reqId: string, allow: boolean) => {
    setDeciding(reqId);
    try {
      await api.approve(sessionId, reqId, allow);
      stream.getState().resolveApproval(reqId);
    } finally {
      setDeciding(null);
    }
  };

  const onPromote = async () => {
    setPromoting(true);
    try {
      const res = await api.promote(sessionId);
      if (res.prUrl) setPrUrl(res.prUrl);
      void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    } finally {
      setPromoting(false);
    }
  };

  const onSelect = (path: string) => {
    setSelectedPath(path);
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar
        orgSlug={org}
        projectId={project}
        projectName={undefined}
        session={sessionQ.data}
        status={status}
        connection={connection}
        onPromote={onPromote}
        promoting={promoting}
        prUrl={prUrl}
      />
      <div className="min-h-0 flex-1">
        <ErrorBoundary>
          <IdeLayout
            tree={
              <FileTree
                sessionId={sessionId}
                selectedPath={selectedPath}
                onSelect={onSelect}
                refreshToken={treeRefreshToken}
              />
            }
            editor={
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800">
                  <button
                    onClick={() => setMode("file")}
                    aria-pressed={mode === "file"}
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                      mode === "file"
                        ? "bg-neutral-200 dark:bg-neutral-800"
                        : "text-neutral-500",
                    )}
                  >
                    <Files className="h-3.5 w-3.5" aria-hidden /> File
                  </button>
                  <button
                    onClick={() => setMode("diff")}
                    aria-pressed={mode === "diff"}
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                      mode === "diff"
                        ? "bg-neutral-200 dark:bg-neutral-800"
                        : "text-neutral-500",
                    )}
                  >
                    <GitCompareArrows className="h-3.5 w-3.5" aria-hidden /> Diff
                  </button>
                  {selectedPath ? (
                    <span className="ml-2 truncate font-mono text-xs text-neutral-500">
                      {selectedPath}
                    </span>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1">
                  <EditorDiff
                    sessionId={sessionId}
                    path={selectedPath}
                    mode={mode}
                    refreshToken={fileRefreshToken}
                  />
                </div>
              </div>
            }
            agent={
              <AgentPanel
                events={events}
                approvals={approvals}
                running={status === "running"}
                sending={sending}
                onSend={onSend}
                onInterrupt={onInterrupt}
                onDecide={onDecide}
                decidingReqId={deciding}
              />
            }
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
