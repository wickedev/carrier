import { Button } from "@carrier/ui";

/**
 * App is the root component. Later phases replace this with the React Router
 * route tree (login, org/project navigation, and the IDE split-view session
 * page). This foundation renders a placeholder shell.
 */
export function App() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <h1 className="text-2xl font-semibold">Carrier</h1>
      <p className="text-sm text-neutral-500">Web client — foundation scaffold.</p>
      <Button>Sign in with GitHub</Button>
    </div>
  );
}
