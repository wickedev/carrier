// In-memory per-session usage tally (task 20). The SSE relay accumulates token
// counts from normalized `usage` / `step_finish` Carrier events into this store;
// the /usage endpoints read per-session totals and roll them up across the
// sessions of a project / org. Cost is estimated from a small per-model price
// table (tokens with no known model price contribute 0 cost).

import type { RawCarrierEvent } from "@carrier/carrier-client";
import { type Usage, UsageSchema } from "@carrier/contract";

export interface TokenDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Optional model id used to price this delta. */
  model?: string;
}

/** Per-model USD price per 1,000 tokens. Unknown models price at 0. */
export interface ModelPrice {
  inputPer1k: number;
  outputPer1k: number;
  cacheReadPer1k: number;
  cacheWritePer1k: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4": {
    inputPer1k: 0.015,
    outputPer1k: 0.075,
    cacheReadPer1k: 0.0015,
    cacheWritePer1k: 0.01875,
  },
  "claude-sonnet-4": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cacheReadPer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  },
  "claude-haiku-4": {
    inputPer1k: 0.0008,
    outputPer1k: 0.004,
    cacheReadPer1k: 0.00008,
    cacheWritePer1k: 0.001,
  },
};

interface Tally {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

function emptyTally(): Tally {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

/**
 * Extract a token delta from a raw Carrier event. Returns null for events that
 * carry no usage. Recognizes `usage` and `step_finish` kinds (and any event
 * that happens to carry token fields).
 */
export function usageDeltaFromRaw(raw: RawCarrierEvent): TokenDelta | null {
  if (raw.kind !== "usage" && raw.kind !== "step_finish") return null;
  const input = raw.input_tokens ?? 0;
  const output = raw.output_tokens ?? 0;
  const cacheRead = raw.cache_read_tokens ?? 0;
  const cacheWrite = raw.cache_write_tokens ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    return null;
  }
  // `model` is not part of the typed RawCarrierEvent wire shape; read it
  // defensively when Carrier includes it on a usage frame.
  const model = (raw as { model?: unknown }).model;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    model: typeof model === "string" ? model : undefined,
  };
}

export class UsageStore {
  private readonly bySession = new Map<string, Tally>();

  constructor(private readonly prices: Record<string, ModelPrice> = DEFAULT_PRICES) {}

  private cost(delta: TokenDelta): number {
    const price = delta.model ? this.prices[delta.model] : undefined;
    if (!price) return 0;
    return (
      (delta.inputTokens / 1000) * price.inputPer1k +
      (delta.outputTokens / 1000) * price.outputPer1k +
      (delta.cacheReadTokens / 1000) * price.cacheReadPer1k +
      (delta.cacheWriteTokens / 1000) * price.cacheWritePer1k
    );
  }

  /** Accumulate a token delta against a session's running tally. */
  add(sessionId: string, delta: TokenDelta): void {
    const t = this.bySession.get(sessionId) ?? emptyTally();
    t.inputTokens += delta.inputTokens;
    t.outputTokens += delta.outputTokens;
    t.cacheReadTokens += delta.cacheReadTokens;
    t.cacheWriteTokens += delta.cacheWriteTokens;
    t.costUsd += this.cost(delta);
    this.bySession.set(sessionId, t);
  }

  /** Current usage for a single session (zeros if none recorded). */
  forSession(sessionId: string): Usage {
    return UsageSchema.parse(this.bySession.get(sessionId) ?? emptyTally());
  }

  /** Roll up usage across a set of session ids (sum of tallies). */
  rollup(sessionIds: readonly string[]): Usage {
    const acc = emptyTally();
    for (const id of sessionIds) {
      const t = this.bySession.get(id);
      if (!t) continue;
      acc.inputTokens += t.inputTokens;
      acc.outputTokens += t.outputTokens;
      acc.cacheReadTokens += t.cacheReadTokens;
      acc.cacheWriteTokens += t.cacheWriteTokens;
      acc.costUsd += t.costUsd;
    }
    return UsageSchema.parse(acc);
  }
}
