import type { Usage } from "@carrier/contract";
import { Coins } from "lucide-react";
import { cn } from "@carrier/ui";

/** Format a USD cost compactly (e.g. $0.0123, $1.45). */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  const digits = usd > 0 && usd < 1 ? 4 : 2;
  return `$${usd.toFixed(digits)}`;
}

/** Format a token count with thousands separators / k-m abbreviations. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Compact per-session usage readout for the IDE TopBar (Req 16/20). Renders
 * total tokens (input+output) and the accumulated cost.
 */
export function UsagePill({
  usage,
  loading,
  className,
}: {
  usage?: Usage;
  loading?: boolean;
  className?: string;
}) {
  if (loading || !usage) {
    return loading ? (
      <span className={cn("text-2xs text-fg-muted", className)} data-testid="usage-pill">
        usage…
      </span>
    ) : null;
  }
  const tokens = usage.inputTokens + usage.outputTokens;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border border-line px-1.5 py-0.5 font-mono text-2xs text-fg-muted",
        className,
      )}
      data-testid="usage-pill"
      title={`in ${usage.inputTokens} / out ${usage.outputTokens} tokens · cache r${usage.cacheReadTokens}/w${usage.cacheWriteTokens}`}
    >
      <Coins className="h-3 w-3" aria-hidden />
      {formatTokens(tokens)} tok · {formatUsd(usage.costUsd)}
    </span>
  );
}
