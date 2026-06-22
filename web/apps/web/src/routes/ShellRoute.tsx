import { useRouteLoaderData } from "react-router";
import type { Me } from "@carrier/contract";
import { Shell } from "../components/Shell";
import { ErrorState } from "../components/primitives";

/** Layout route: reads the root loader's `Me` and renders the app shell. */
export function ShellRoute() {
  const me = useRouteLoaderData("root") as Me | undefined;
  if (!me) {
    // Should not happen — the loader either returns Me or redirects to /login.
    return <ErrorState title="Session error" message="Unable to load your account." />;
  }
  return <Shell me={me} />;
}
