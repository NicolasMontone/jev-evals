import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING, estimateCostUsd, sumUsage } from '../src/cost.js';

describe('estimateCostUsd', () => {
  it('matches the documented ~$0.04/1M input token rate', () => {
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.04, 10);
  });

  it('adds input and output cost', () => {
    const cost = estimateCostUsd(
      { inputTokens: 500_000, outputTokens: 250_000, totalTokens: 750_000 },
      { inputPerMillion: 0.04, outputPerMillion: 0.08 },
    );
    expect(cost).toBeCloseTo(0.5 * 0.04 + 0.25 * 0.08, 10);
  });

  it('uses DEFAULT_PRICING when no override is given', () => {
    const cost = estimateCostUsd({ inputTokens: 2_000_000, outputTokens: 1_000_000, totalTokens: 3_000_000 });
    expect(cost).toBeCloseTo(2 * DEFAULT_PRICING.inputPerMillion + 1 * DEFAULT_PRICING.outputPerMillion, 10);
  });
});

describe('sumUsage', () => {
  it('sums across multiple usage records', () => {
    const total = sumUsage([
      { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      undefined,
    ]);
    expect(total).toEqual({ inputTokens: 30, outputTokens: 3, totalTokens: 33 });
  });

  it('derives totalTokens when missing from a partial record', () => {
    const total = sumUsage([{ inputTokens: 5, outputTokens: 5 }]);
    expect(total.totalTokens).toBe(10);
  });

  it('returns all zeros for an empty list', () => {
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});
