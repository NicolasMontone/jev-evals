import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/concurrency.js';

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const delays = [30, 0, 20, 0];
    const results = await mapWithConcurrency(delays, 4, async (delay, i) => {
      await new Promise((r) => setTimeout(r, delay));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('handles an empty input list', async () => {
    const results = await mapWithConcurrency([], 5, async (x) => x);
    expect(results).toEqual([]);
  });

  it('handles concurrency greater than the item count', async () => {
    const results = await mapWithConcurrency([1, 2], 100, async (x) => x * 2);
    expect(results).toEqual([2, 4]);
  });

  it('propagates an error from one item without hanging', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
  });
});
