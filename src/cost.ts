import type { UsageTotals } from './types.js';

export interface PricingConfig {
  /** USD per 1,000,000 input tokens. Jev is documented at ~$0.04/1M. */
  inputPerMillion: number;
  /**
   * USD per 1,000,000 output tokens. Jev's answers are tiny structured
   * objects, so output tokens are usually a rounding error next to input
   * tokens (which carry the full state + all rubric instructions/criteria).
   * Not separately documented for jev; defaults to the same rate as input
   * so the estimate errs conservative rather than pretending output is
   * free. Override via `RunEvalOptions.pricing` if you have a better number.
   */
  outputPerMillion: number;
}

export const DEFAULT_PRICING: PricingConfig = {
  inputPerMillion: 0.04,
  outputPerMillion: 0.04,
};

export function estimateCostUsd(usage: UsageTotals, pricing: PricingConfig = DEFAULT_PRICING): number {
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}

export function sumUsage(items: Array<Partial<UsageTotals> | undefined>): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const u of items) {
    if (!u) continue;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  }
  return { inputTokens, outputTokens, totalTokens };
}
