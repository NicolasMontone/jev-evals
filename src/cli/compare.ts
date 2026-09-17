import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compareRuns } from '../compareRuns.js';
import type { RunResult } from '../types.js';
import { flagBoolean, flagNumber, type ParsedArgs } from './args.js';
import { buildMarkdownSummary, printCompareSummary } from './format.js';
import { readJsonFile } from './io.js';

export async function compareCommand(args: ParsedArgs): Promise<number> {
  const [baselinePath, currentPath] = args.positionals;
  if (!baselinePath || !currentPath) {
    console.error('Usage: jev-evals compare <baseline.json> <current.json> [options]');
    return 1;
  }

  const baseline = await readJsonFile<RunResult>(resolve(process.cwd(), baselinePath));
  const current = await readJsonFile<RunResult>(resolve(process.cwd(), currentPath));

  const tolerance = flagNumber(args.flags, 'tolerance');
  const asJson = flagBoolean(args.flags, 'json');
  const markdownPath = args.flags['markdown'];

  const diff = compareRuns(baseline, current, tolerance !== undefined ? { tolerance } : {});

  if (typeof markdownPath === 'string') {
    await writeFile(resolve(process.cwd(), markdownPath), buildMarkdownSummary(current, diff) + '\n', 'utf8');
  }

  if (asJson) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    printCompareSummary(diff);
  }

  return diff.hasRegression ? 1 : 0;
}
