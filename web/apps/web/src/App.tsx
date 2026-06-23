import * as React from "react";
import { RouterProvider } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { createRouter } from "./routes/router";
import { ToastProvider } from "./components/toast";
import { installGlobalErrorTelemetry, recordRouteChange } from "./telemetry";

/**
 * App root: builds the React Router v7 data-mode router (loaders are wired to
 * the shared QueryClient for cache priming) and renders it. Also installs web
 * telemetry (Task 24): route-change tracking via the router subscription and
 * global error/rejection handlers.
 */
export function App() {
  const queryClient = useQueryClient();
  // Build the router once; it captures the stable QueryClient.
  const router = React.useMemo(() => createRouter(queryClient), [queryClient]);

  React.useEffect(() => installGlobalErrorTelemetry(), []);

  React.useEffect(() => {
    // Record the initial route, then every subsequent navigation.
    recordRouteChange(router.state.location.pathname);
    return router.subscribe((state) => {
      if (state.navigation.state === "idle") {
        recordRouteChange(state.location.pathname);
      }
    });
  }, [router]);

  return (
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  );
}
