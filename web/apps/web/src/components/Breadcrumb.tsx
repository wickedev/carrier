import * as React from "react";

/**
 * Breadcrumb — the shared route-page breadcrumb nav (org / project / settings /
 * marketplace). Callers pass `<Link>`/`<span>` children and `<BreadcrumbSep />`
 * separators; the current/leaf segment uses `text-accent`. This is for route
 * pages only — the IDE TopBar breadcrumb is separate chrome with a different
 * leaf style and is intentionally not shared here.
 */
export function Breadcrumb({ children }: { children: React.ReactNode }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-2 text-xs uppercase tracking-[0.1em] text-fg-muted"
    >
      {children}
    </nav>
  );
}

/** The "/" separator between breadcrumb segments. */
export function BreadcrumbSep() {
  return <span className="text-fg-subtle">/</span>;
}
