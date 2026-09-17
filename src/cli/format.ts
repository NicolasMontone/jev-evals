import type { CompareResult, RunResult } from '../types.js';

export function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(4)}`;
}

export function formatNum(n: number): string {
  if (Number.isNaN(n)) return 'n/a';
  return n.toFixed(3);
}

export function formatPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return 'n/a';
  return `${(n * 100).toFixed(0)}%`;
}

export function printRunSummary(run: RunResult): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`jev-evals: ${run.suite}`);
  lines.push('-'.repeat(40));
  lines.push(`cases:     ${run.passed}/${run.total} passed`);
  lines.push(`time:      ${run.ms}ms`);
  lines.push(
    `usage:     ${run.usage.inputTokens} in / ${run.usage.outputTokens} out / ${run.usage.totalTokens} total tokens`,
  );
  lines.push(`est. cost: ${formatUsd(run.estimatedCostUsd)}`);
  lines.push('');
  lines.push('rubric              type      mean     pass%   n');
  for (const [id, agg] of Object.entries(run.perRubric)) {
    lines.push(
      `${id.padEnd(20)}${agg.type.padEnd(10)}${formatNum(agg.mean).padEnd(9)}${formatPct(agg.passRate).padEnd(8)}${agg.count}`,
    );
  }
  const failing = run.perCase.filter((c) => !c.passed || c.error);
  if (failing.length > 0) {
    lines.push('');
    lines.push(`failing cases (${failing.length}):`);
    for (const c of failing) {
      if (c.error) {
        lines.push(`  - ${c.id}: ERROR: ${c.error}`);
      } else {
        const failedRubrics = Object.values(c.rubrics)
          .filter((r) => r.passed === false)
          .map((r) => r.rubricId);
        lines.push(`  - ${c.id}: failed [${failedRubrics.join(', ')}]`);
      }
    }
  }
  lines.push('');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

export function printCompareSummary(diff: CompareResult): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`jev-evals compare: ${diff.baselineSuite} -> ${diff.currentSuite}`);
  lines.push('-'.repeat(40));
  lines.push(`tolerance: ${diff.tolerance}`);
  lines.push('');
  lines.push('rubric              status      baseline   current    diff');
  for (const d of diff.deltas) {
    lines.push(
      `${d.rubricId.padEnd(20)}${d.status.padEnd(12)}${fmtOrNa(d.baselineMean).padEnd(11)}${fmtOrNa(d.currentMean).padEnd(11)}${fmtDiff(d.diff)}`,
    );
  }
  lines.push('');
  lines.push(diff.hasRegression ? 'RESULT: regression detected' : 'RESULT: no regression');
  lines.push('');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

function fmtOrNa(n: number | null): string {
  return n === null ? 'n/a' : formatNum(n);
}

function fmtDiff(n: number | null): string {
  if (n === null) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(3)}`;
}

/** A markdown summary suitable for posting as a PR comment. */
export function buildMarkdownSummary(run: RunResult, diff?: CompareResult): string {
  const lines: string[] = [];
  const badge = run.success ? '✅' : '❌';
  lines.push(`### ${badge} jev-evals: \`${run.suite}\``);
  lines.push('');
  lines.push(`**${run.passed}/${run.total}** cases passed · **${formatUsd(run.estimatedCostUsd)}** ` +
    `(${run.usage.totalTokens} tokens) · ${run.ms}ms`);
  lines.push('');
  lines.push('| Rubric | Type | Mean | Pass % |' + (diff ? ' Δ vs baseline |' : ''));
  lines.push('|---|---|---|---|' + (diff ? '---|' : ''));
  for (const [id, agg] of Object.entries(run.perRubric)) {
    const deltaCell = diff ? renderDeltaCell(diff, id) : '';
    lines.push(
      `| \`${id}\` | ${agg.type} | ${formatNum(agg.mean)} | ${formatPct(agg.passRate)} |` +
        (diff ? ` ${deltaCell} |` : ''),
    );
  }

  const failing = run.perCase.filter((c) => !c.passed || c.error);
  if (failing.length > 0) {
    lines.push('');
    lines.push(`<details><summary>${failing.length} failing case(s)</summary>`);
    lines.push('');
    for (const c of failing) {
      if (c.error) {
        lines.push(`- \`${c.id}\`: **ERROR** — ${c.error}`);
      } else {
        const failedRubrics = Object.values(c.rubrics)
          .filter((r) => r.passed === false)
          .map((r) => `\`${r.rubricId}\` (${formatNum(r.numericValue)})`);
        lines.push(`- \`${c.id}\`: ${failedRubrics.join(', ')}`);
      }
    }
    lines.push('');
    lines.push('</details>');
  }

  if (diff && diff.hasRegression) {
    lines.push('');
    lines.push(`> ⚠️ Regression detected in: ${diff.regressed.map((d) => `\`${d.rubricId}\``).join(', ')}`);
  }

  return lines.join('\n');
}

function renderDeltaCell(diff: CompareResult, rubricId: string): string {
  const d = diff.deltas.find((x) => x.rubricId === rubricId);
  if (!d || d.diff === null) return 'n/a';
  const icon = d.status === 'regressed' ? '🔻' : d.status === 'improved' ? '🔺' : '▪️';
  const sign = d.diff > 0 ? '+' : '';
  return `${icon} ${sign}${d.diff.toFixed(3)}`;
}
