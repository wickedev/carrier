import * as React from "react";
import { useParams } from "react-router";
import { useStore } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { Files, GitCompareArrows } from "lucide-react";

import { api, eventsUrl } from "../api/client";
import { useSession, useSessionUsage, useProject, qk } from "../api/queries";
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
import { Toggle } from "../components/primitives";

/** /:org/:project/s/:session — the IDE split-view (Req 8–11). */
export function SessionPage() {
  const { org = "", project = "", session: sessionId = "" } = useParams();
  const qc = useQueryClient();
  const sessionQ = useSession(sessionId);
  // The repo binding lives on the Project (Project.repo), not the Session.
  // When bound, promote OPENS A PR; when unbound, it MERGES directly to base.
  // Tri-state: undefined until the project loads, so the TopBar never presents a
  // definite (destructive) promote action before the binding is known.
  const projectQ = useProject(project);
  const repoBound = projectQ.data ? Boolean(projectQ.data.repo) : undefined;
  // Per-session usage/cost (Req 20). Poll while the session is running; tolerate
  // the endpoint being unavailable (don't surface a hard error in the IDE).
  const usageQ = useSessionUsage(sessionId, {
    retry: false,
    refetchInterval: 15_000,
  });

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
  const [promoteStatus, setPromoteStatus] = React.useState<string | null>(null);

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
      } else if (e.kind === "title") {
        // The runtime auto-generated a session title (the BFF has already
        // persisted it). Refresh the session detail (drives the TopBar title)
        // and the project's session list (renders s.title).
        void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
        void qc.invalidateQueries({ queryKey: qk.sessions(project) });
      }
    }
  }, [events, selectedPath, sessionId, project, qc]);

  const onSend = async (
    text: string,
    opts: { steer: boolean; model?: string; effort?: string; planMode?: boolean },
  ) => {
    setSending(true);
    try {
      await api.sendInput(sessionId, text, opts);
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
    setPromoteStatus(null);
    try {
      const res = await api.promote(sessionId);
      if (res.prUrl) {
        setPrUrl(res.prUrl);
        setPromoteStatus("PR opened");
      } else if (res.ok) {
        setPromoteStatus("merged");
      } else {
        setPromoteStatus(res.message ?? "promote failed");
      }
      void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    } catch (e) {
      setPromoteStatus(e instanceof Error ? e.message : "promote failed");
    } finally {
      setPromoting(false);
    }
  };

  // Approval timeout (Req 11.4): an unanswered approval auto-denies. Deliver the
  // timeout-denial to the BFF (best-effort) and clear it from the pending list.
  const onApprovalExpire = (reqId: string) => {
    void api.approve(sessionId, reqId, false).catch(() => undefined);
    stream.getState().resolveApproval(reqId);
  };

  const onSelect = (path: string) => {
    setSelectedPath(path);
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar
        orgSlug={org}
        projectId={project}
        session={sessionQ.data}
        repoBound={repoBound}
        status={status}
        connection={connection}
        onPromote={onPromote}
        promoting={promoting}
        prUrl={prUrl}
        promoteStatus={promoteStatus}
        usage={usageQ.data}
        usageLoading={usageQ.isLoading}
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
                <div className="flex items-center gap-1 border-b border-line px-2 py-1">
                  <Toggle
                    variant="subtle"
                    value={mode}
                    onChange={setMode}
                    options={[
                      {
                        value: "file",
                        label: " File",
                        icon: <Files className="h-3.5 w-3.5" aria-hidden />,
                      },
                      {
                        value: "diff",
                        label: " Diff",
                        icon: <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />,
                      },
                    ]}
                  />
                  {selectedPath ? (
                    <span className="ml-auto truncate font-mono text-xs text-fg-muted">
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
                onApprovalExpire={onApprovalExpire}
              />
            }
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
