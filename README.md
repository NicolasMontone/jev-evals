# jev-evals

A rubric-based eval harness for LLM/agent outputs, backed by the
[`typesafe-ai/jev`](https://www.npmjs.com/package/ai) evaluation model via the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

## The pitch

LLM-as-judge normally costs about as much as the generation it's judging —
one prompt in, one verdict out, per rubric. That symmetry is exactly why
nobody runs evals on every commit: doubling your generation cost to check
your generation quality doesn't survive contact with a budget.

Jev breaks that symmetry two ways:

1. **One round trip answers every rubric for a case.** `input`, `output`,
   and `expected` are sent once as shared *state*; every rubric is a
   *question* against that same state, all answered together. Judging a
   case against 10 rubrics costs one call, not ten.
2. **Jev is priced at ~$0.04 per 1M input tokens** — roughly two orders of
   magnitude below a general-purpose model used as a judge.

### The arithmetic

Say a support-agent suite has 3 rubrics, ~800 input tokens of shared state
(input + output + expected) plus ~400 tokens of rubric instructions/criteria
= **~1,200 input tokens per case**, and you run **50 cases per PR**:

| | naive LLM-as-judge (1 call per rubric, general model, e.g. $3/1M in) | jev-evals (1 call per case, jev, $0.04/1M in) |
|---|---:|---:|
| calls per PR | 150 (50 cases × 3 rubrics) | 50 |
| input tokens per PR | ~180,000 (150 × 1,200) | ~60,000 (50 × 1,200 — one call *shares* the state) |
| cost per PR | **~$0.54** | **~$0.0024** |
| cost for 500 PRs/month | ~$270/month | ~$1.20/month |

The per-rubric-call number gets worse the more rubrics you have (it scales
with `cases × rubrics`); jev-evals scales with `cases` alone, on a rate
~75x cheaper per token. That gap is the whole reason this package exists:
it makes "run the eval suite on every PR, not just before a release" an
actual option instead of a line item someone vetoes.

This is why the harness is built the way it is:

- **One `evaluate()` call per case is non-negotiable.** [`runEval`](#runeval)
  builds one shared `state` per case and sends every rubric for that case as
  one batch of `questions`. See [Architecture](#architecture-one-round-trip-per-case).
- **The CLI prints what a run actually cost**, from real `usage` data, so
  "is this affordable" is never a guess (see [`estimatedCostUsd`](#cost-estimation)).
- **Fractional scores are preserved everywhere**, because a regression from
  2.97 to 2.81 is real signal that a naive judge (or a harness that rounds)
  would throw away — see [Fractional scores](#fractional-scores-are-a-feature).

## Install

```sh
npm install jev-evals ai
```

`ai` (`^7.0.105`) is a peer dependency — jev-evals doesn't pin or vendor it,
so you control your AI SDK version.

## Auth

jev-evals does **not** implement authentication itself. It calls the `ai`
SDK's `experimental_evaluate`, which resolves credentials on its own, in
this order:

1. **`AI_GATEWAY_API_KEY`** — an [AI Gateway API
   key](https://vercel.com/docs/ai-gateway#api-keys). Set it directly, or via
   your CI secrets.
2. **`VERCEL_OIDC_TOKEN`** — an OIDC token from a linked Vercel project. Get
   one locally with:

   ```sh
   vercel env pull
   ```

   This token is short-lived (12 hours), which is fine for CI runs but means
   a long-lived local dev session will need to re-pull it periodically.

If neither is set, `runEval()` throws a `AuthError` up front, before making
any calls, with both options spelled out — rather than letting the first
`evaluate()` call fail deep inside a `Promise.all`.

## API

### `defineEval`

```ts
import { defineEval } from 'jev-evals';

const suite = defineEval({
  name: 'support-agent',
  rubrics: {
    answersQuestion: { type: 'boolean', instructions: 'Does the output answer the input?' },
    noFabrication:   { type: 'boolean', instructions: 'Are all cited facts present in the input?' },
    tone:            { type: 'score', instructions: 'Rate the tone.', criteria: ['rude', 'neutral', 'warm'] },
  },
  thresholds: { answersQuestion: 0.9, noFabrication: 0.95, tone: 1.5 },
  cases: [
    { id: 'refund-1', input: 'Can I get a refund?', output: 'Yes — refunded within 3-5 business days.' },
  ],
});
```

`defineEval` is a typed identity function: it validates the suite up front
(non-empty rubrics, valid rubric shapes, unique case ids, thresholds that
reference real rubrics, at least one way to produce every case's `output`)
and throws `InvalidSuiteError` with a specific message if something's
wrong, rather than letting a typo surface as a confusing jev error.

A case can also generate its own output instead of shipping a pre-computed
one:

```ts
const suite = defineEval({
  name: 'support-agent',
  rubrics: { /* ... */ },
  // suite-level default; per-case `generate` overrides it
  generate: async (input) => callMyAgent(input),
  cases: [
    { id: 'refund-1', input: 'Can I get a refund?' }, // output produced by `generate`
    { id: 'refund-2', input: 'Where is my order?', generate: (input) => callOtherAgent(input) },
    { id: 'refund-3', input: 'Can I get a refund?', output: 'Yes.' }, // pre-computed, generate skipped
  ],
});
```

### `runEval`

```ts
import { runEval } from 'jev-evals';

const run = await runEval(suite, { concurrency: 8 });
```

```ts
interface RunEvalOptions {
  concurrency?: number;              // cases in parallel. Default 5.
  maxQuestionsPerCall?: number;      // overrides suite.maxQuestionsPerCall
  model?: string;                    // default 'typesafe-ai/jev'
  abortSignal?: AbortSignal;
  maxRetries?: number;               // passed through to evaluate()
  pricing?: Partial<PricingConfig>;  // override $/1M token rates
  onCaseComplete?: (result, index, total) => void;
  skipAuthCheck?: boolean;           // for tests; see below
}
```

Returns a `RunResult`:

```ts
interface RunResult {
  suite: string;
  passed: number;   // cases where every thresholded rubric passed
  failed: number;   // cases with a threshold failure or a runtime error
  total: number;
  success: boolean; // failed === 0 — what the CLI uses for its exit code
  perCase: CaseResult[];             // one entry per case, in input order
  perRubric: Record<string, RubricAggregate>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  estimatedCostUsd: number;
  ms: number;
  timestamp: string;
  rubricTypes: Record<string, 'boolean' | 'choice' | 'score'>;
}
```

Each `CaseResult` carries the resolved `input`/`output`/`expected`, a
`RubricResult` per rubric (the raw `Answer`, a normalized `numericValue`,
and `passed`/`threshold` if one was configured), and an `error` string
instead of `rubrics` if generation or evaluation threw for that case — a
single bad case never aborts the whole run.

### `compareRuns`

```ts
import { compareRuns } from 'jev-evals';

const diff = compareRuns(baselineRun, currentRun, { tolerance: 0.05 });
// { deltas, regressed, improved, unchanged, hasRegression, tolerance, ... }
```

Compares two `RunResult`s (e.g. one loaded from a JSON file saved by a
previous CI run, one just produced) rubric by rubric, on their aggregate
`mean`. A rubric present on only one side shows up as `'new'` or
`'removed'` rather than being silently dropped. `tolerance` (default 0.05,
in the rubric's own numeric scale) absorbs run-to-run noise: a diff whose
absolute value is at or under `tolerance` is `'unchanged'`; otherwise it's
`'regressed'` (mean went down) or `'improved'` (mean went up).

### Rubric types — and when to use each

All three mirror the jev API exactly (see below); jev-evals doesn't add or
reinterpret fields.

- **`boolean`** — a yes/no judgment. Answer is `{ probability }`, the
  model's P(true), **always present** (not a hard true/false). Use it for
  binary checks: "does the output answer the question", "is this safe",
  "are all cited facts present in the input". Threshold it as a minimum
  probability (e.g. `0.9`).

  ```ts
  { type: 'boolean', instructions: 'Does the output answer the input?' }
  ```

- **`score`** — an ordered scale with 2+ levels, **lowest to highest**.
  Answer is `{ score }`, a **fractional** value in `[0, levels - 1]` — e.g.
  a 3-level scale (`['rude', 'neutral', 'warm']`) can return `1.85`, not
  just `0`, `1`, or `2`. Use it for quality/degree judgments: tone,
  thoroughness, helpfulness. Threshold it as a minimum raw score on that
  same scale (e.g. `1.5` for "at least halfway between neutral and warm").

  ```ts
  { type: 'score', instructions: 'Rate the tone.', criteria: ['rude', 'neutral', 'warm'] }
  ```

- **`choice`** — pick one of N named options, each with a description.
  Answer is `{ choice }`, the chosen key. Use it when the outcomes are
  categorical rather than ordered/binary: "which failure mode, if any",
  "which of these tools should have been called". Threshold it with the
  accepted choice(s): a string, or an array for "any of these".

  ```ts
  { type: 'choice', instructions: 'Which tool should the agent have called?', criteria: { search: '...', none: '...' } }
  ```

  If a choice rubric's options *are* ordered (rare, but sometimes a
  3-option "tone" makes more sense as a `choice` than a `score`), jev-evals
  aggregates it as an ordinal: the chosen option's position among the
  `criteria` keys, normalized to `0..1`. This only makes sense when you
  wrote the keys in low-to-high order — jev-evals can't verify that, so
  prefer `score` when the levels are genuinely ordered.

### Fractional scores are a feature

A `score` rubric answers with a real number like `2.97`, not an integer.
jev-evals never rounds it — not in `CaseResult.rubrics[id].numericValue`,
not in `RubricAggregate.mean`, not when comparing runs. Rounding `2.97` and
`2.81` both to `3` erases exactly the kind of small regression that a
per-PR eval suite exists to catch; a mean of `2.94` this run vs `2.81` last
run is a real, visible signal that both scores round away.

### Cost estimation

`RunResult.usage` sums every `evaluate()` call's real `usage` field (from
every case, and every chunk if a suite was split — see below).
`estimatedCostUsd` applies a $/1M-token rate to it: jev's documented
input-token rate (`$0.04`) by default for both input and output (jev's
output-token rate isn't separately published; output is a tiny structured
answer object, so this errs conservative rather than pretending it's free).
Override via `RunEvalOptions.pricing` or the CLI's `--input-price` /
`--output-price` if you have a better number.

### Architecture: one round trip per case

For a given case, jev-evals builds **one** `state` object —
`{ input, output, expected? }` — and **one** `questions` map — every rubric
in the suite — and calls `evaluate()` **once**. That's the entire
cost/latency story: N rubrics judged in parallel by the model in a single
request, not N requests.

`maxQuestionsPerCall` (suite-level, default 40; override per run via
`RunEvalOptions.maxQuestionsPerCall`) exists as a safety valve, not a
tuning knob you should reach for: a single `evaluate()` call still has to
fit inside the provider's context/response budget, and a suite with, say,
200 rubrics on one case would either fail outright or degrade badly if
forced through one call. Above the limit, jev-evals splits that case's
rubrics into batches of `maxQuestionsPerCall` and fires them **concurrently**
(not sequentially), merging the answers and summing usage — so you don't
lose correctness, but you do lose some of the one-round-trip win. Keeping
suites under the limit (the common case — most rubric sets are single
digits to a few dozen) is what gets you the cost/latency profile this
package is built around.

### Concurrency

Cases run with a bounded worker pool (`RunEvalOptions.concurrency`, default
5) so a large suite doesn't fire hundreds of requests at once. `perCase`
results always come back in the same order as `suite.cases`, regardless of
which case's `evaluate()` call happens to resolve first.

## CLI

```
jev-evals run <suite-file> [options]
jev-evals compare <baseline.json> <current.json> [options]
```

`<suite-file>` is a JS module (`.js`/`.mjs`) that `export default`s (or
`export const suite =`) a suite built with `defineEval`. If you write suites
in TypeScript, run them through `tsx` or compile them first:

```sh
npx tsx node_modules/.bin/jev-evals run ./evals/support-agent.ts
# or
npx tsc evals/support-agent.ts --outDir dist-evals --module esnext --target es2022 --moduleResolution bundler
jev-evals run ./dist-evals/support-agent.js
```

### `run`

```
jev-evals run ./evals/support-agent.js \
  --save results/latest.json \
  --baseline results/main.json --tolerance 0.05 \
  --markdown results/summary.md \
  --concurrency 8
```

| Flag | Meaning |
|---|---|
| `--save <path>` | Write the full `RunResult` JSON to `<path>` (your next baseline). |
| `--baseline <path>` | Compare this run against a saved `RunResult` and report regressions. |
| `--tolerance <n>` | Regression tolerance for `--baseline` (default 0.05). |
| `--concurrency <n>` | Max cases in parallel (default 5). |
| `--max-questions-per-call <n>` | Override the suite's limit. |
| `--model <id>` | Model id passed to `evaluate()` (default `typesafe-ai/jev`). |
| `--max-retries <n>` | Passed through to `evaluate()`. |
| `--input-price <usd/1M>` / `--output-price <usd/1M>` | Override cost-estimate pricing. |
| `--markdown <path>` | Write a PR-comment-ready markdown summary to `<path>`. |
| `--json` | Print the full result (and compare diff, if any) as JSON instead of a table. |

Exit code is non-zero when any case fails a threshold, or (with
`--baseline`) when a regression is detected — built to be used directly as
a CI gate.

### `compare`

```
jev-evals compare results/main.json results/pr.json --tolerance 0.05 --markdown results/summary.md
```

Same `--tolerance`, `--markdown`, `--json` flags; compares two previously
saved `RunResult` files without re-running anything. Exit code is non-zero
iff a regression is detected.

## GitHub Actions: eval on every PR

```yaml
name: evals
on: pull_request

jobs:
  jev-evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Run evals
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
        run: |
          npx jev-evals run ./evals/support-agent.js \
            --save results.json \
            --baseline .evals-baseline/support-agent.json \
            --markdown summary.md
      - name: Comment on PR
        if: always()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          path: summary.md
      # On merge to main, separately commit results.json as the new
      # .evals-baseline/support-agent.json so the next PR diffs against it.
```

Because a run is one round trip per case at ~$0.04/1M input tokens, this
step is cheap enough to run on *every* PR rather than being gated to
nightly or pre-release — see the [arithmetic](#the-arithmetic) above.

## Worked example

```ts
// evals/support-agent.ts
import { defineEval, runEval, compareRuns } from 'jev-evals';
import { readFileSync } from 'node:fs';
import { supportAgent } from '../src/agent.js';

const suite = defineEval({
  name: 'support-agent',
  rubrics: {
    answersQuestion: {
      type: 'boolean',
      instructions: 'Does the output directly answer the question in the input?',
    },
    noFabrication: {
      type: 'boolean',
      instructions: 'Are all facts the output cites actually present in the input?',
      criteria: {
        true: 'Every claim traces back to something in the input.',
        false: 'The output invents or assumes a fact not in the input.',
      },
    },
    tone: {
      type: 'score',
      instructions: 'Rate the tone of the response toward the customer.',
      criteria: ['rude or dismissive', 'neutral / businesslike', 'warm and empathetic'],
    },
  },
  thresholds: { answersQuestion: 0.9, noFabrication: 0.95, tone: 1.4 },
  generate: (input) => supportAgent(String(input)),
  cases: [
    { id: 'refund-1', input: 'Can I get a refund for my order?' },
    { id: 'shipping-1', input: 'Where is my order? It has been a week.' },
    { id: 'angry-1', input: 'This product broke after two days, I want my money back NOW.' },
  ],
});

async function main() {
  const run = await runEval(suite, { concurrency: 5 });

  let baseline;
  try {
    baseline = JSON.parse(readFileSync('.evals-baseline/support-agent.json', 'utf8'));
  } catch {
    // first run, no baseline yet
  }

  if (baseline) {
    const diff = compareRuns(baseline, run, { tolerance: 0.05 });
    if (diff.hasRegression) {
      console.error('Regressions:', diff.regressed);
      process.exitCode = 1;
    }
  }

  console.log(`${run.passed}/${run.total} passed, est. cost $${run.estimatedCostUsd.toFixed(4)}`);
}

main();
```

Or the same thing from the CLI, once `support-agent.ts` exports `suite` as
its default export:

```sh
jev-evals run ./evals/support-agent.js --baseline .evals-baseline/support-agent.json --save results.json
```

## The verified jev API

For reference, this is exactly what `runEval` calls underneath — jev-evals
adds no fields and reinterprets none of them:

```ts
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',
  state,        // string | JSONObject | JSONValue[] — ONE shared state
  questions,    // { [id]: Question } — ALL answered in ONE round trip
  abortSignal,  // optional
  maxRetries,   // optional, defaults to 2
});
// result.answers[id], result.usage, result.warnings, result.rounding,
// result.providerMetadata (confidence at .typesafe.confidence), result.response
```

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

Tests mock `experimental_evaluate` at the module boundary — there is no
live network path to the AI Gateway in CI or in this repo's test
environment, and none of the tests attempt one.

## License

MIT
