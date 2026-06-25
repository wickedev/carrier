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
        className={cn("border border-line bg-panel", className)}
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
        "inline-flex items-center text-xs font-bold uppercase tracking-[0.1em]",
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
        "flex items-center gap-2 border-b border-line uppercase tracking-[0.15em]",
        tone === "neutral"
          ? "bg-panel px-3 py-1.5 text-2xs font-bold text-fg-muted"
          : "bg-panel px-3 py-2 text-xs font-bold text-warning",
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
                "inline-flex items-center gap-1 border-b-2 px-2 py-0.5 text-xs focus-ring",
                active
                  ? "border-accent text-accent"
                  : "border-transparent text-fg-muted",
              )
            : cn(
                "px-2 py-0.5 focus-ring",
                active ? "bg-accent font-bold text-accent-fg" : "text-fg-muted",
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
      <div className="inline-flex overflow-hidden border border-line">
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
          "h-9 w-full border border-line bg-transparent px-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus-ring",
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
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-fg">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-fg-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Error",
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
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-fg">{title}</p>
      {message ? <p className="max-w-md text-sm text-fg-muted">{message}</p> : null}
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-2 text-sm font-medium text-info underline-offset-2 hover:underline"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
