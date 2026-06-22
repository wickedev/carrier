import * as React from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

function Handle() {
  return (
    <PanelResizeHandle className="w-px bg-neutral-200 transition-colors hover:bg-blue-400 data-[resize-handle-state=drag]:bg-blue-500 dark:bg-neutral-800" />
  );
}

/** Three-pane resizable IDE layout: FileTree | EditorDiff | AgentPanel. */
export function IdeLayout({
  tree,
  editor,
  agent,
}: {
  tree: React.ReactNode;
  editor: React.ReactNode;
  agent: React.ReactNode;
}) {
  return (
    <PanelGroup direction="horizontal" autoSaveId="carrier-ide" className="h-full">
      <Panel defaultSize={18} minSize={12} className="overflow-hidden">
        <div className="h-full border-r border-neutral-200 dark:border-neutral-800">{tree}</div>
      </Panel>
      <Handle />
      <Panel defaultSize={52} minSize={25} className="overflow-hidden">
        <div className="h-full">{editor}</div>
      </Panel>
      <Handle />
      <Panel defaultSize={30} minSize={20} className="overflow-hidden">
        <div className="h-full border-l border-neutral-200 dark:border-neutral-800">{agent}</div>
      </Panel>
    </PanelGroup>
  );
}
