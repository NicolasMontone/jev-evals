import { experimental_evaluate as evaluate } from 'ai';
import type {
  Answer,
  CaseResult,
  EvalCase,
  EvalSuite,
  Input,
  Rubric,
  RubricAggregate,
  RubricMap,
  RubricResult,
  RunResult,
  Threshold,
  UsageTotals,
} from './types.js';
import { mapWithConcurrency } from './concurrency.js';
import { DEFAULT_PRICING, estimateCostUsd, sumUsage, type PricingConfig } from './cost.js';

const DEFAULT_MAX_QUESTIONS_PER_CALL = 40;
const DEFAULT_CONCURRENCY = 5;

export class AuthError extends Error {
  constructor() {
    super(
      'No credentials found for the AI Gateway. Set one of:\n' +
        '  - AI_GATEWAY_API_KEY   (an AI Gateway API key)\n' +
        '  - VERCEL_OIDC_TOKEN    (run `vercel env pull` in a Vercel project; lasts 12h)\n' +
        'jev-evals does not implement auth itself — it relies on the `ai` SDK picking ' +
        'one of these up. See the README for both paths.',
    );
    this.name = 'AuthError';
  }
}

export interface RunEvalOptions {
  /** Max cases evaluated in parallel. Default 5. */
  concurrency?: number;
  /** Overrides `suite.maxQuestionsPerCall`. */
  maxQuestionsPerCall?: number;
  /** Model id passed to `evaluate()`. Default 'typesafe-ai/jev'. */
  model?: string;
  abortSignal?: AbortSignal;
  /** Passed through to `evaluate()`. Defaults to the AI SDK's own default (2). */
  maxRetries?: number;
  /** Pricing used for `estimatedCostUsd`. Defaults to jev's documented ~$0.04/1M input rate. */
  pricing?: Partial<PricingConfig>;
  /** Called as each case finishes, in completion order (not result order). */
  onCaseComplete?: (result: CaseResult, index: number, total: number) => void;
  /**
   * Skip the AI Gateway credential preflight check. Intended for tests that
   * mock `experimental_evaluate` and never actually hit the network.
   */
  skipAuthCheck?: boolean;
}

function checkAuth(skip: boolean | undefined): void {
  if (skip) return;
  if (process.env['AI_GATEWAY_API_KEY'] || process.env['VERCEL_OIDC_TOKEN']) return;
  throw new AuthError();
}

function chunkEntries<T>(entries: [string, T][], size: number): [string, T][][] {
  if (entries.length <= size) return [entries];
  const chunks: [string, T][][] = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}

function choiceOrdinal(rubric: Rubric, choice: string): number {
  if (rubric.type !== 'choice') return 0;
  const keys = Object.keys(rubric.criteria);
  const idx = keys.indexOf(choice);
  if (idx < 0 || keys.length <= 1) return 0;
  return idx / (keys.length - 1);
}

function numericValueOf(rubric: Rubric, answer: Answer): number {
  switch (answer.type) {
    case 'boolean':
      return answer.probability;
    case 'score':
      return answer.score;
    case 'choice':
      return choiceOrdinal(rubric, answer.choice);
  }
}

function evaluateThreshold(rubric: Rubric, answer: Answer, threshold: Threshold): boolean {
  if (answer.type === 'choice') {
    const accepted = Array.isArray(threshold) ? threshold : [threshold as string];
    return accepted.includes(answer.choice);
  }
  const numericThreshold = typeof threshold === 'number' ? threshold : Number(threshold);
  const value = answer.type === 'boolean' ? answer.probability : answer.score;
  return value >= numericThreshold;
}

async function resolveOutput(evalCase: EvalCase, suite: EvalSuite<RubricMap>): Promise<Input> {
  if (evalCase.output !== undefined) return evalCase.output;
  const generate = evalCase.generate ?? suite.generate;
  if (!generate) {
    // defineEval() should have caught this already, but stay defensive for
    // suites constructed by hand without defineEval().
    throw new Error(`Case "${evalCase.id}" has no \`output\` and no \`generate\` function.`);
  }
  return await generate(evalCase.input, evalCase);
}

interface EvaluateOneCaseArgs {
  suite: EvalSuite<RubricMap>;
  evalCase: EvalCase;
  model: string;
  maxQuestionsPerCall: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}

async function evaluateOneCase(args: EvaluateOneCaseArgs): Promise<CaseResult> {
  const { suite, evalCase, model, maxQuestionsPerCall, abortSignal, maxRetries } = args;

  let output: Input;
  try {
    output = await resolveOutput(evalCase, suite);
  } catch (err) {
    return {
      id: evalCase.id,
      input: evalCase.input,
      output: undefined,
      expected: evalCase.expected,
      metadata: evalCase.metadata,
      rubrics: {},
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const state: Input = {
    input: evalCase.input,
    output,
    ...(evalCase.expected !== undefined ? { expected: evalCase.expected } : {}),
  };

  const rubricEntries = Object.entries(suite.rubrics);
  const chunks = chunkEntries(rubricEntries, maxQuestionsPerCall);

  try {
    // All rubrics for this case go out in as few round trips as possible:
    // exactly one unless the suite exceeds `maxQuestionsPerCall`, in which
    // case chunks run concurrently rather than sequentially.
    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        evaluate({
          model,
          state,
          questions: Object.fromEntries(chunk) as Record<string, Rubric>,
          ...(abortSignal ? { abortSignal } : {}),
          ...(maxRetries !== undefined ? { maxRetries } : {}),
        }),
      ),
    );

    const answers: Record<string, Answer> = {};
    const warnings: unknown[] = [];
    for (const result of chunkResults) {
      Object.assign(answers, result.answers);
      if (result.warnings) warnings.push(...result.warnings);
    }
    const usage = sumUsage(chunkResults.map((r) => r.usage));

    const rubrics: Record<string, RubricResult> = {};
    for (const [id, rubric] of rubricEntries) {
      const answer = answers[id];
      if (!answer) continue;
      const numericValue = numericValueOf(rubric, answer);
      const threshold = suite.thresholds?.[id];
      const passed = threshold === undefined ? null : evaluateThreshold(rubric, answer, threshold);
      rubrics[id] = {
        rubricId: id,
        type: rubric.type,
        answer,
        numericValue,
        passed,
        ...(threshold !== undefined ? { threshold } : {}),
      };
    }

    const passed = Object.values(rubrics).every((r) => r.passed !== false);

    return {
      id: evalCase.id,
      input: evalCase.input,
      output,
      expected: evalCase.expected,
      metadata: evalCase.metadata,
      rubrics,
      passed,
      usage,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (err) {
    return {
      id: evalCase.id,
      input: evalCase.input,
      output,
      expected: evalCase.expected,
      metadata: evalCase.metadata,
      rubrics: {},
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function aggregate(
  suite: EvalSuite<RubricMap>,
  perCase: CaseResult[],
): Record<string, RubricAggregate> {
  const out: Record<string, RubricAggregate> = {};
  for (const [id, rubric] of Object.entries(suite.rubrics)) {
    const values: number[] = [];
    let passCount = 0;
    let thresholdCount = 0;
    for (const c of perCase) {
      const r = c.rubrics[id];
      if (!r) continue;
      values.push(r.numericValue);
      if (r.passed !== null) {
        thresholdCount++;
        if (r.passed) passCount++;
      }
    }
    out[id] = {
      rubricId: id,
      type: rubric.type,
      mean: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : NaN,
      min: values.length > 0 ? Math.min(...values) : NaN,
      max: values.length > 0 ? Math.max(...values) : NaN,
      passRate: thresholdCount > 0 ? passCount / thresholdCount : null,
      count: values.length,
    };
  }
  return out;
}

export async function runEval(
  suite: EvalSuite<RubricMap>,
  options: RunEvalOptions = {},
): Promise<RunResult> {
  checkAuth(options.skipAuthCheck);

  const model = options.model ?? 'typesafe-ai/jev';
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxQuestionsPerCall =
    options.maxQuestionsPerCall ?? suite.maxQuestionsPerCall ?? DEFAULT_MAX_QUESTIONS_PER_CALL;
  const pricing: PricingConfig = { ...DEFAULT_PRICING, ...options.pricing };

  const start = Date.now();
  const total = suite.cases.length;
  let completed = 0;

  const perCase = await mapWithConcurrency(suite.cases, concurrency, async (evalCase) => {
    const result = await evaluateOneCase({
      suite,
      evalCase,
      model,
      maxQuestionsPerCall,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
    completed++;
    options.onCaseComplete?.(result, completed, total);
    return result;
  });

  const ms = Date.now() - start;
  const passed = perCase.filter((c) => c.passed && !c.error).length;
  const failed = total - passed;
  const usage: UsageTotals = sumUsage(perCase.map((c) => c.usage));

  const rubricTypes: Record<string, Rubric['type']> = {};
  for (const [id, rubric] of Object.entries(suite.rubrics)) {
    rubricTypes[id] = rubric.type;
  }

  return {
    suite: suite.name,
    passed,
    failed,
    total,
    success: failed === 0,
    perCase,
    perRubric: aggregate(suite, perCase),
    usage,
    estimatedCostUsd: estimateCostUsd(usage, pricing),
    ms,
    timestamp: new Date().toISOString(),
    rubricTypes,
  };
}
