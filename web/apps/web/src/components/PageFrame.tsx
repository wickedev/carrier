import * as React from "react";

/**
 * PageFrame — the shared outer frame for route pages (org / project / settings /
 * marketplace). Uses `min-h-full` rather than a hardcoded
 * `min-h-[calc(100vh-3.25rem)]`: the page sits inside Shell's
 * `<main className="min-h-0 flex-1">`, so 100% of that height fills correctly
 * without baking in the header height.
 */
export function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid-rule min-h-full">
      <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
    </div>
  );
}
