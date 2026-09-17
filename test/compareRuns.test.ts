import { describe, expect, it } from 'vitest';
import { compareRuns } from '../src/compareRuns.js';
import type { RunResult } from '../src/types.js';

function makeRun(overrides: Partial<RunResult> & { perRubric: RunResult['perRubric'] }): RunResult {
  return {
    suite: 'suite',
    passed: 1,
    failed: 0,
    total: 1,
    success: true,
    perCase: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    estimatedCostUsd: 0,
    ms: 0,
    timestamp: new Date(0).toISOString(),
    rubricTypes: {},
    ...overrides,
  };
}

describe('compareRuns', () => {
  it('classifies a drop beyond tolerance as regressed', () => {
    const baseline = makeRun({
      perRubric: { tone: { rubricId: 'tone', type: 'score', mean: 2.0, min: 2, max: 2, passRate: 1, count: 1 } },
    });
    const current = makeRun({
      perRubric: { tone: { rubricId: 'tone', type: 'score', mean: 1.5, min: 1.5, max: 1.5, passRate: 0, count: 1 } },
    });
    const diff = compareRuns(baseline, current, { tolerance: 0.05 });
    expect(diff.hasRegression).toBe(true);
    expect(diff.regressed.map((d) => d.rubricId)).toEqual(['tone']);
    expect(diff.deltas.find((d) => d.rubricId === 'tone')!.diff).toBeCloseTo(-0.5);
  });

  it('classifies a rise beyond tolerance as improved', () => {
    const baseline = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.7, min: 0.7, max: 0.7, passRate: 0, count: 1 } },
    });
    const current = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.95, min: 0.95, max: 0.95, passRate: 1, count: 1 } },
    });
    const diff = compareRuns(baseline, current, { tolerance: 0.05 });
    expect(diff.improved.map((d) => d.rubricId)).toEqual(['a']);
    expect(diff.hasRegression).toBe(false);
  });

  it('treats a change within tolerance as unchanged (not noise-triggered)', () => {
    const baseline = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.9, min: 0.9, max: 0.9, passRate: 1, count: 1 } },
    });
    const current = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.87, min: 0.87, max: 0.87, passRate: 1, count: 1 } },
    });
    const diff = compareRuns(baseline, current, { tolerance: 0.05 });
    expect(diff.deltas[0]!.status).toBe('unchanged');
    expect(diff.hasRegression).toBe(false);
  });

  it('boundary: a diff exactly at tolerance is unchanged, not regressed', () => {
    const baseline = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.9, min: 0.9, max: 0.9, passRate: 1, count: 1 } },
    });
    const current = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.85, min: 0.85, max: 0.85, passRate: 1, count: 1 } },
    });
    const diff = compareRuns(baseline, current, { tolerance: 0.05 });
    expect(diff.deltas[0]!.status).toBe('unchanged');
  });

  it('boundary: a diff just past tolerance is regressed', () => {
    const baseline = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.9, min: 0.9, max: 0.9, passRate: 1, count: 1 } },
    });
    const current = makeRun({
      perRubric: {
        a: { rubricId: 'a', type: 'boolean', mean: 0.9 - 0.0501, min: 0, max: 0, passRate: 1, count: 1 },
      },
    });
    const diff = compareRuns(baseline, current, { tolerance: 0.05 });
    expect(diff.deltas[0]!.status).toBe('regressed');
  });

  it('flags a rubric only present in the current run as new, and only in baseline as removed', () => {
    const baseline = makeRun({
      perRubric: { old: { rubricId: 'old', type: 'boolean', mean: 0.9, min: 0.9, max: 0.9, passRate: 1, count: 1 } },
    });
    const current = makeRun({
      perRubric: { fresh: { rubricId: 'fresh', type: 'boolean', mean: 0.9, min: 0.9, max: 0.9, passRate: 1, count: 1 } },
    });
    const diff = compareRuns(baseline, current);
    expect(diff.deltas.find((d) => d.rubricId === 'old')!.status).toBe('removed');
    expect(diff.deltas.find((d) => d.rubricId === 'fresh')!.status).toBe('new');
    expect(diff.hasRegression).toBe(false);
  });

  it('defaults tolerance to 0.05 when not specified', () => {
    const baseline = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.9, min: 0.9, max: 0.9, passRate: 1, count: 1 } },
    });
    const current = makeRun({
      perRubric: { a: { rubricId: 'a', type: 'boolean', mean: 0.86, min: 0.86, max: 0.86, passRate: 1, count: 1 } },
    });
    const diff = compareRuns(baseline, current);
    expect(diff.tolerance).toBe(0.05);
    expect(diff.deltas[0]!.status).toBe('unchanged');
  });
});
