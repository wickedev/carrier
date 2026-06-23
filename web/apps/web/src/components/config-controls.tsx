import * as React from "react";
import { Trash2 } from "lucide-react";
import { Card, Loading, ErrorState } from "./primitives";

/**
 * Shared controls + section shell for the config / settings / marketplace list
 * pages. Promoted out of `routes/config-sections.tsx` so the member-remove,
 * permission-delete, and plugin-uninstall/-toggle copies stop re-inlining the
 * same markup.
 */

/** Toggle switch for an `enabled` flag, shown on every list row. */
export function EnableToggle({
  enabled,
  disabled,
  onChange,
  label,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-fg-muted">
      <input
        type="checkbox"
        checked={enabled}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
      />
      {enabled ? "on" : "off"}
    </label>
  );
}

/** Delete (trash) control for a list row. */
export function DeleteButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded text-neutral-400 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
    >
      <Trash2 className="h-4 w-4" aria-hidden />
    </button>
  );
}

/**
 * The repeated "Card + heading + add-form + list" shell. Owns the
 * loading/error/empty/list branches (copied verbatim from the canonical
 * AgentsSection body) so each section only provides its form slot and a
 * per-item renderer.
 */
export interface ConfigSectionQuery<T> {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: T[] | undefined;
  refetch: () => void;
}

export function ConfigSection<T>({
  title,
  subtitle,
  icon,
  testId,
  form,
  query,
  renderItem,
  emptyText,
  emptyState,
}: {
  title: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  testId: string;
  /** The manage-gated add-form (already gated by the caller). */
  form?: React.ReactNode;
  query: ConfigSectionQuery<T>;
  renderItem: (item: T) => React.ReactNode;
  /** Plain empty-state text (rendered as a muted paragraph). */
  emptyText?: string;
  /** Rich empty-state node; overrides `emptyText` when provided. */
  emptyState?: React.ReactNode;
}) {
  return (
    <Card className="mb-4 p-4" data-testid={testId}>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {title}
      </h2>
      {subtitle}

      {form}

      {query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.data && query.data.length > 0 ? (
        <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {query.data.map((item) => renderItem(item))}
        </ul>
      ) : emptyState !== undefined ? (
        emptyState
      ) : (
        <p className="text-sm text-fg-muted">{emptyText}</p>
      )}
    </Card>
  );
}
