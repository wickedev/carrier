import * as React from "react";
import { cn } from "@carrier/ui";
import { Loader2, AlertTriangle } from "lucide-react";

/** Small reusable UI primitives built on top of @carrier/ui (do not edit packages/ui). */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} aria-hidden />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-950",
        className,
      )}
      {...props}
    />
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center gap-2 p-8 text-sm text-fg-muted"
      role="status"
      aria-live="polite"
    >
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-fg-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center"
      role="alert"
    >
      <AlertTriangle className="h-6 w-6 text-danger" aria-hidden />
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{title}</p>
      {message ? <p className="max-w-md text-sm text-fg-muted">{message}</p> : null}
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-2 text-sm font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
