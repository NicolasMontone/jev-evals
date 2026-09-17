import type { CompareResult, DeltaStatus, RubricDelta, RunResult } from './types.js';

export interface CompareOptions {
  /**
   * Absolute difference (in the rubric's own numeric scale — 0..1 for
   * boolean/choice, 0..levels-1 for score) below which a change is
   * considered noise rather than a real regression or improvement.
   * Default 0.05.
   */
  tolerance?: number;
}

const DEFAULT_TOLERANCE = 0.05;

/**
 * Compares a baseline run (e.g. loaded from a JSON file saved by a previous
 * CI run) against a current run, per rubric, using the rubrics' aggregate
 * means. A rubric that only exists on one side is reported as 'new' or
 * 'removed' rather than silently ignored.
 */
export function compareRuns(baseline: RunResult, current: RunResult, options: CompareOptions = {}): CompareResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;

  const rubricIds = new Set<string>([
    ...Object.keys(baseline.perRubric),
    ...Object.keys(current.perRubric),
  ]);

  const deltas: RubricDelta[] = [];

  for (const id of rubricIds) {
    const base = baseline.perRubric[id];
    const cur = current.perRubric[id];

    if (base && !cur) {
      deltas.push({
        rubricId: id,
        type: base.type,
        baselineMean: base.mean,
        currentMean: null,
        diff: null,
        status: 'removed',
      });
      continue;
    }
    if (cur && !base) {
      deltas.push({
        rubricId: id,
        type: cur.type,
        baselineMean: null,
        currentMean: cur.mean,
        diff: null,
        status: 'new',
      });
      continue;
    }
    if (!base || !cur) continue; // unreachable, satisfies TS

    const diff = cur.mean - base.mean;
    let status: DeltaStatus;
    // A tiny epsilon absorbs floating-point noise from mean/diff
    // arithmetic (e.g. 0.9 - 0.85 !== 0.05 in IEEE 754) so a diff that is
    // conceptually exactly at the tolerance boundary doesn't flip to
    // "regressed" or "improved" depending on which way it happens to round.
    const epsilon = 1e-9;
    if (Math.abs(diff) <= tolerance + epsilon) {
      status = 'unchanged';
    } else if (diff < 0) {
      status = 'regressed';
    } else {
      status = 'improved';
    }

    deltas.push({
      rubricId: id,
      type: cur.type,
      baselineMean: base.mean,
      currentMean: cur.mean,
      diff,
      status,
    });
  }

  // Stable, readable ordering: regressions first (most useful in a PR
  // comment), then improvements, then everything else, alphabetically
  // within each group.
  const order: Record<DeltaStatus, number> = {
    regressed: 0,
    improved: 1,
    new: 2,
    removed: 3,
    unchanged: 4,
  };
  deltas.sort((a, b) => order[a.status] - order[b.status] || a.rubricId.localeCompare(b.rubricId));

  return {
    baselineSuite: baseline.suite,
    currentSuite: current.suite,
    tolerance,
    deltas,
    regressed: deltas.filter((d) => d.status === 'regressed'),
    improved: deltas.filter((d) => d.status === 'improved'),
    unchanged: deltas.filter((d) => d.status === 'unchanged'),
    hasRegression: deltas.some((d) => d.status === 'regressed'),
  };
}
