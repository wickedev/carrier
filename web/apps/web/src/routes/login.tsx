import { Github } from "lucide-react";
import { buttonVariants } from "@carrier/ui";
import { ThemeToggleStandalone } from "./shared";

/** /login — GitHub SSO. The link navigates to the BFF OAuth start endpoint. */
export function LoginPage() {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-6 bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="absolute right-3 top-3">
        <ThemeToggleStandalone />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold">Carrier</h1>
        <p className="text-sm text-neutral-500">Sign in to access your projects.</p>
      </div>
      <a href="/auth/github" className={buttonVariants()}>
        <Github className="h-4 w-4" aria-hidden />
        Sign in with GitHub
      </a>
    </div>
  );
}
