import { useRouteError, isRouteErrorResponse, Link } from "react-router";
import { ErrorState } from "../components/primitives";

/** Route-level error element (Req 18.3) — contains loader/render failures. */
export function RouteError() {
  const error = useRouteError();

  let title = "Something went wrong";
  let message: string | undefined;

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    message = typeof error.data === "string" ? error.data : undefined;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-50 dark:bg-neutral-950">
      <ErrorState title={title} message={message} />
      <Link to="/" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        Go home
      </Link>
    </div>
  );
}
