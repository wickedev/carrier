import * as React from "react";
import { Github } from "lucide-react";
import { Button, buttonVariants } from "@carrier/ui";
import { Input } from "../components/primitives";
import { ThemeToggleStandalone } from "./shared";
import { api } from "../api/client";

/** Human-readable messages for the BFF's auth error codes. */
const ERROR_LABELS: Record<string, string> = {
  invalid_credentials: "Incorrect email or password.",
  email_taken: "An account with that email already exists.",
  invalid_body: "Please enter a valid email and a password (min 8 characters).",
};

// In dev only (never in a production build — import.meta.env.DEV is false there),
// prefill the form with the seeded dev credentials so you can sign in with one
// click. Overridable via VITE_DEV_EMAIL / VITE_DEV_PASSWORD.
const devEnv = import.meta.env as unknown as {
  VITE_DEV_EMAIL?: string;
  VITE_DEV_PASSWORD?: string;
};
const DEV_EMAIL = import.meta.env.DEV
  ? (devEnv.VITE_DEV_EMAIL ?? "dev@carrier.local")
  : "";
const DEV_PASSWORD = import.meta.env.DEV
  ? (devEnv.VITE_DEV_PASSWORD ?? "carrierdev")
  : "";

/** /login — email/password (with a dev default) plus GitHub SSO. */
export function LoginPage() {
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [email, setEmail] = React.useState(DEV_EMAIL);
  const [password, setPassword] = React.useState(DEV_PASSWORD);
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await api.login({ email, password });
      } else {
        await api.register({ email, password, name: name || undefined });
      }
      // Reload so the root loader re-fetches /me with the new session cookie.
      window.location.assign("/");
    } catch (err) {
      const code = err instanceof Error ? err.message : "error";
      setError(ERROR_LABELS[code] ?? "Something went wrong. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-6 bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="absolute right-3 top-3">
        <ThemeToggleStandalone />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold">Carrier</h1>
        <p className="text-sm text-fg-muted">
          {mode === "login"
            ? "Sign in to access your projects."
            : "Create your account."}
        </p>
      </div>

      <form
        onSubmit={submit}
        className="flex w-72 flex-col gap-3"
        data-testid="password-auth-form"
      >
        {mode === "register" ? (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            aria-label="Name"
            autoComplete="name"
          />
        ) : null}
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email"
          autoComplete="email"
        />
        <Input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy || !email || !password}>
          {mode === "login" ? "Sign in" : "Create account"}
        </Button>
      </form>

      <button
        type="button"
        className="text-sm text-fg-muted hover:underline"
        onClick={() => {
          setMode((m) => (m === "login" ? "register" : "login"));
          setError(null);
        }}
      >
        {mode === "login"
          ? "Need an account? Register"
          : "Already have an account? Sign in"}
      </button>

      <div className="flex w-72 items-center gap-3 text-xs text-fg-muted">
        <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        or
        <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
      </div>

      <a href="/auth/github" className={buttonVariants({ variant: "outline" })}>
        <Github className="h-4 w-4" aria-hidden />
        Sign in with GitHub
      </a>
    </div>
  );
}
