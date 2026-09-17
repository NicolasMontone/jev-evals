#!/usr/bin/env node
import { parseArgs } from './cli/args.js';
import { runCommand } from './cli/run.js';
import { compareCommand } from './cli/compare.js';

const HELP = `jev-evals — rubric-based evals for LLM/agent outputs, backed by typesafe-ai/jev.

Usage:
  jev-evals run <suite-file> [options]      Run a suite and print/save results.
  jev-evals compare <baseline.json> <current.json> [options]
                                             Compare two saved runs.

Options for "run":
  --save <path>              Write the full RunResult as JSON to <path>.
  --baseline <path>          Compare this run against a previously saved
                              RunResult JSON and report regressions.
  --tolerance <n>            Regression tolerance passed to compareRuns
                              (only with --baseline). Default 0.05.
  --concurrency <n>          Max cases evaluated in parallel. Default 5.
  --max-questions-per-call <n>
                              Override the suite's maxQuestionsPerCall.
  --model <id>                Model id passed to evaluate(). Default typesafe-ai/jev.
  --max-retries <n>           Passed through to evaluate().
  --input-price <usd/1M>      Override input token pricing for cost estimate.
  --output-price <usd/1M>     Override output token pricing for cost estimate.
  --markdown <path>           Write a PR-comment-ready markdown summary to <path>.
  --json                      Print machine-readable JSON instead of a table.

Options for "compare":
  --tolerance <n>              Regression tolerance. Default 0.05.
  --markdown <path>             Write a markdown summary to <path>.
  --json                        Print machine-readable JSON instead of a table.

Exit code is non-zero when any case fails its thresholds, or (with
--baseline / compare) when a regression is detected — suitable for use as a
CI gate.

Auth (not implemented by this package — see README):
  AI_GATEWAY_API_KEY   an AI Gateway API key, or
  VERCEL_OIDC_TOKEN    from \`vercel env pull\` (12h lifetime)
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const helpRequested = Boolean(args.flags['help'] || args.flags['h']);
  if (helpRequested || !args.command) {
    console.log(HELP);
    process.exitCode = helpRequested ? 0 : 1;
    return;
  }

  if (args.flags['version']) {
    // Kept in sync with package.json manually; avoided reading package.json
    // at runtime to keep the built CLI a single self-contained file.
    console.log('jev-evals 0.1.0');
    return;
  }

  switch (args.command) {
    case 'run':
      process.exitCode = await runCommand(args);
      return;
    case 'compare':
      process.exitCode = await compareCommand(args);
      return;
    default:
      console.error(`Unknown command "${args.command}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
