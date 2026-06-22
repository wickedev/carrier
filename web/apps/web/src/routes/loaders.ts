import { redirect, type LoaderFunctionArgs } from "react-router";
import type { Me } from "@carrier/contract";
import { api, UnauthorizedError } from "../api/client";
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "../api/queries";

/**
 * Root loader / auth guard (Req 1.5). Resolves `/me`; on 401 it redirects to
 * `/login` preserving the intended destination as `?next=`. Returns the `Me`
 * payload (also primed into the Query cache) for the shell + child routes.
 *
 * Injectable `deps` (api + queryClient) keep the loader unit-testable with a
 * mocked fetch.
 */
export interface LoaderDeps {
  api: Pick<typeof api, "me">;
  queryClient?: QueryClient;
}

export function makeRootLoader(deps: LoaderDeps) {
  return async function rootLoader({ request }: LoaderFunctionArgs): Promise<Me> {
    try {
      const me = await deps.api.me(request.signal);
      deps.queryClient?.setQueryData(qk.me, me);
      return me;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        const url = new URL(request.url);
        const next = url.pathname + url.search;
        const to = next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
        throw redirect(to);
      }
      throw err;
    }
  };
}

/** `/` index loader — redirect to the first/active org (Req frontend route tree). */
export function makeIndexLoader(deps: LoaderDeps) {
  return async function indexLoader({ request }: LoaderFunctionArgs) {
    const me = await deps.api.me(request.signal).catch(() => null);
    if (!me) throw redirect("/login");
    const first = me.orgs[0];
    if (!first) {
      // No contexts yet — land on a neutral page (login acts as onboarding stub).
      return null;
    }
    throw redirect(`/${first.slug}`);
  };
}
