import * as React from "react";
import { RouterProvider } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { createRouter } from "./routes/router";

/**
 * App root: builds the React Router v7 data-mode router (loaders are wired to
 * the shared QueryClient for cache priming) and renders it.
 */
export function App() {
  const queryClient = useQueryClient();
  // Build the router once; it captures the stable QueryClient.
  const router = React.useMemo(() => createRouter(queryClient), [queryClient]);
  return <RouterProvider router={router} />;
}
