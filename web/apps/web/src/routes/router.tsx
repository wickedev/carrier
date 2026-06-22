import { createBrowserRouter, redirect } from "react-router";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { makeRootLoader, makeIndexLoader } from "./loaders";
import { ShellRoute } from "./ShellRoute";
import { LoginPage } from "./login";
import { OrgPage } from "./org";
import { ProjectPage } from "./project";
import { SessionPage } from "./session";
import { OrgSettingsPage, ProjectSettingsPage } from "./settings";
import { RouteError } from "./RouteError";

/**
 * React Router v7 data-mode route tree.
 *
 * /login                       GitHub SSO (public)
 * / (root, ShellRoute)         auth-guarded layout; root loader = /me
 *   index                      → redirect to active org
 *   /:org                      project list
 *   /:org/settings             org settings
 *   /:org/:project             session list + overview
 *   /:org/:project/settings    repo binding, permissions, danger zone
 *   /:org/:project/s/:session  the IDE split-view
 */
export function createRouter(queryClient: QueryClient) {
  const rootLoader = makeRootLoader({ api, queryClient });
  const indexLoader = makeIndexLoader({ api, queryClient });

  return createBrowserRouter([
    { path: "/login", element: <LoginPage /> },
    {
      id: "root",
      path: "/",
      loader: rootLoader,
      element: <ShellRoute />,
      errorElement: <RouteError />,
      children: [
        { index: true, loader: indexLoader, element: null },
        { path: ":org", element: <OrgPage /> },
        { path: ":org/settings", element: <OrgSettingsPage /> },
        { path: ":org/:project", element: <ProjectPage /> },
        { path: ":org/:project/settings", element: <ProjectSettingsPage /> },
        { path: ":org/:project/s/:session", element: <SessionPage /> },
      ],
    },
    { path: "*", loader: () => redirect("/") },
  ]);
}
