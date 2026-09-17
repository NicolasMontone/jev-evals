import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runEval } from '../runEval.js';
import { compareRuns } from '../compareRuns.js';
import type { EvalSuite, RubricMap, RunResult } from '../types.js';
import { flagBoolean, flagNumber, flagString, type ParsedArgs } from './args.js';
import { buildMarkdownSummary, printCompareSummary, printRunSummary } from './format.js';
import { readJsonFile } from './io.js';

async function loadSuite(path: string): Promise<EvalSuite<RubricMap>> {
  const abs = resolve(process.cwd(), path);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const candidate = mod.default ?? mod.suite ?? mod;
  if (!candidate || typeof candidate !== 'object' || !('cases' in candidate)) {
    throw new Error(
      `"${path}" does not export an EvalSuite. Export it as \`export default suite\` ` +
        `or \`export const suite = ...\`.`,
    );
  }
  return candidate as EvalSuite<RubricMap>;
}

export async function runCommand(args: ParsedArgs): Promise<number> {
  const suitePath = args.positionals[0];
  if (!suitePath) {
    console.error('Usage: jev-evals run <suite-file> [options]');
    return 1;
  }

  const suite = await loadSuite(suitePath);

  const concurrency = flagNumber(args.flags, 'concurrency');
  const maxQuestionsPerCall = flagNumber(args.flags, 'max-questions-per-call');
  const model = flagString(args.flags, 'model');
  const maxRetries = flagNumber(args.flags, 'max-retries');
  const inputPrice = flagNumber(args.flags, 'input-price');
  const outputPrice = flagNumber(args.flags, 'output-price');
  const asJson = flagBoolean(args.flags, 'json');
  const savePath = flagString(args.flags, 'save');
  const baselinePath = flagString(args.flags, 'baseline');
  const tolerance = flagNumber(args.flags, 'tolerance');
  const markdownPath = flagString(args.flags, 'markdown');

  const run = await runEval(suite, {
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(maxQuestionsPerCall !== undefined ? { maxQuestionsPerCall } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(inputPrice !== undefined || outputPrice !== undefined
      ? {
          pricing: {
            ...(inputPrice !== undefined ? { inputPerMillion: inputPrice } : {}),
            ...(outputPrice !== undefined ? { outputPerMillion: outputPrice } : {}),
          },
        }
      : {}),
  });

  if (savePath) {
    await writeFile(resolve(process.cwd(), savePath), JSON.stringify(run, null, 2) + '\n', 'utf8');
  }

  let diff;
  if (baselinePath) {
    const baseline = await readJsonFile<RunResult>(resolve(process.cwd(), baselinePath));
    diff = compareRuns(baseline, run, tolerance !== undefined ? { tolerance } : {});
  }

  if (markdownPath) {
    await writeFile(resolve(process.cwd(), markdownPath), buildMarkdownSummary(run, diff) + '\n', 'utf8');
  }

  if (asJson) {
    console.log(JSON.stringify(diff ? { run, compare: diff } : { run }, null, 2));
  } else {
    printRunSummary(run);
    if (diff) printCompareSummary(diff);
  }

  const failed = !run.success || (diff ? diff.hasRegression : false);
  return failed ? 1 : 0;
}
