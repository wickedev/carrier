import * as React from "react";
import { cn } from "@carrier/ui";
import { Loader2, AlertTriangle } from "lucide-react";

/** Small reusable UI primitives built on top of @carrier/ui (do not edit packages/ui). */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin motion-reduce:animate-none", className)} aria-hidden />;
}

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900",
          className,
        )}
        {...props}
      />
    );
  },
);

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

/**
 * CardHeader — the bordered, tinted top strip shared by tool_call / tool_result /
 * approval cards. `tone` picks the color + padding + text-size preset; the icon
 * element is passed by the caller so its own size travels with it (h-3.5 vs h-4).
 * `mono` wraps the label in a font-mono span (tool_call); otherwise the label is
 * rendered as-is. `trailing` is placed after the label with `ml-auto` spacing
 * (the approval "Expired" badge already carries `ml-auto`).
 */
export function CardHeader({
  tone,
  icon,
  mono,
  trailing,
  children,
}: {
  tone: "neutral" | "amber";
  icon: React.ReactNode;
  mono?: boolean;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b",
        tone === "neutral"
          ? "border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium dark:border-neutral-800 dark:bg-neutral-800/50"
          : "border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
      )}
    >
      {icon}
      {mono ? <span className="font-mono">{children}</span> : children}
      {trailing}
    </div>
  );
}

/**
 * Toggle — a segmented two-or-more option control unifying the File/Diff
 * (`variant="subtle"`) and Queue/Steer (`variant="solid"`, `grouped`) toggles.
 * Each button keeps `type="button"` + `aria-pressed`. `grouped` wraps the
 * buttons in the bordered, rounded container the solid variant uses.
 */
export function Toggle<T extends string>({
  value,
  onChange,
  variant,
  grouped,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  variant: "subtle" | "solid";
  grouped?: boolean;
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode; title?: string }[];
}) {
  const buttons = options.map((opt) => {
    const active = value === opt.value;
    return (
      <button
        key={opt.value}
        type="button"
        title={opt.title}
        aria-pressed={active}
        onClick={() => onChange(opt.value)}
        className={
          variant === "subtle"
            ? cn(
                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                active ? "bg-neutral-200 dark:bg-neutral-800" : "text-fg-muted",
              )
            : cn(
                "px-2 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400",
                active
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-fg-muted",
              )
        }
      >
        {opt.icon}
        {opt.label}
      </button>
    );
  });

  if (grouped) {
    return (
      <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
        {buttons}
      </div>
    );
  }
  return <>{buttons}</>;
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-950",
          className,
        )}
        {...props}
      />
    );
  },
);

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
