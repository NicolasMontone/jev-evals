import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, RubricMap } from '../src/types.js';

const { evaluateMock } = vi.hoisted(() => ({ evaluateMock: vi.fn() }));
vi.mock('ai', () => ({
  experimental_evaluate: evaluateMock,
}));

import { defineEval } from '../src/defineEval.js';
import { AuthError, runEval } from '../src/runEval.js';

function mockAnswering(answerFor: (id: string, q: RubricMap[string], callIndex: number) => Answer) {
  let callIndex = 0;
  evaluateMock.mockImplementation(async (args: { questions: RubricMap }) => {
    const idx = callIndex++;
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(args.questions)) {
      answers[id] = answerFor(id, q, idx);
    }
    return {
      answers,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      warnings: [],
    };
  });
}

beforeEach(() => {
  evaluateMock.mockReset();
});

describe('runEval — one round trip per case', () => {
  it('sends all rubrics for a case in exactly one evaluate() call', async () => {
    mockAnswering((id) => {
      if (id === 'answersQuestion') return { type: 'boolean', probability: 0.97 };
      if (id === 'tone') return { type: 'score', score: 1.5 };
      return { type: 'boolean', probability: 1 };
    });

    const suite = defineEval({
      name: 'one-trip',
      rubrics: {
        answersQuestion: { type: 'boolean', instructions: 'Does it answer?' },
        noFabrication: { type: 'boolean', instructions: 'No fabrication?' },
        tone: { type: 'score', instructions: 'Rate tone.', criteria: ['rude', 'neutral', 'warm'] },
      },
      cases: [{ id: 'case-1', input: 'hi', output: 'hello' }],
    });

    const result = await runEval(suite, { skipAuthCheck: true });

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    const call = evaluateMock.mock.calls[0]![0];
    expect(Object.keys(call.questions)).toEqual(['answersQuestion', 'noFabrication', 'tone']);
    expect(call.model).toBe('typesafe-ai/jev');
    expect(call.state).toEqual({ input: 'hi', output: 'hello' });
    expect(result.perCase[0]!.rubrics['answersQuestion']!.answer).toEqual({
      type: 'boolean',
      probability: 0.97,
    });
  });

  it('shares one state object per case across N cases -> N calls, not N*rubrics', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));

    const suite = defineEval({
      name: 'multi-case',
      rubrics: {
        a: { type: 'boolean', instructions: 'a?' },
        b: { type: 'boolean', instructions: 'b?' },
        c: { type: 'boolean', instructions: 'c?' },
      },
      cases: [
        { id: 'c1', input: '1', output: '1' },
        { id: 'c2', input: '2', output: '2' },
        { id: 'c3', input: '3', output: '3' },
      ],
    });

    await runEval(suite, { skipAuthCheck: true, concurrency: 3 });
    expect(evaluateMock).toHaveBeenCalledTimes(3);
  });

  it('includes expected in state only when the case provides it', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));
    const suite = defineEval({
      name: 'expected',
      rubrics: { a: { type: 'boolean', instructions: 'a?' } },
      cases: [
        { id: 'with-expected', input: 'i', output: 'o', expected: 'e' },
        { id: 'without-expected', input: 'i', output: 'o' },
      ],
    });
    await runEval(suite, { skipAuthCheck: true });
    const [call1, call2] = evaluateMock.mock.calls.map((c) => c[0]);
    expect(call1.state).toEqual({ input: 'i', output: 'o', expected: 'e' });
    expect(call2.state).toEqual({ input: 'i', output: 'o' });
  });
});

describe('runEval — chunking above maxQuestionsPerCall', () => {
  it('splits rubrics into multiple parallel calls and merges answers + usage', async () => {
    mockAnswering((id) => ({ type: 'boolean', probability: id === 'r0' ? 0.9 : 0.1 }));

    const rubrics: RubricMap = {};
    for (let i = 0; i < 5; i++) {
      rubrics[`r${i}`] = { type: 'boolean', instructions: `q${i}` };
    }

    const suite = defineEval({
      name: 'chunked',
      rubrics,
      cases: [{ id: 'case-1', input: 'i', output: 'o' }],
      maxQuestionsPerCall: 2,
    });

    const result = await runEval(suite, { skipAuthCheck: true });

    // 5 rubrics / 2 per call -> ceil(5/2) = 3 calls for this one case.
    expect(evaluateMock).toHaveBeenCalledTimes(3);
    const caseResult = result.perCase[0]!;
    expect(Object.keys(caseResult.rubrics)).toHaveLength(5);
    expect(caseResult.rubrics['r0']!.answer).toEqual({ type: 'boolean', probability: 0.9 });
    expect(caseResult.rubrics['r4']!.answer).toEqual({ type: 'boolean', probability: 0.1 });
    // usage summed across the 3 chunk calls: 100/10/110 each
    expect(caseResult.usage).toEqual({ inputTokens: 300, outputTokens: 30, totalTokens: 330 });
  });

  it('runEval option overrides suite.maxQuestionsPerCall', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));
    const rubrics: RubricMap = { a: { type: 'boolean', instructions: 'a' }, b: { type: 'boolean', instructions: 'b' } };
    const suite = defineEval({ name: 's', rubrics, cases: [{ id: 'c', input: 'i', output: 'o' }] });
    await runEval(suite, { skipAuthCheck: true, maxQuestionsPerCall: 1 });
    expect(evaluateMock).toHaveBeenCalledTimes(2);
  });
});

describe('runEval — thresholds', () => {
  it('boolean threshold uses probability', async () => {
    mockAnswering((id) => ({ type: 'boolean', probability: id === 'good' ? 0.96 : 0.5 }));
    const suite = defineEval({
      name: 'bool-threshold',
      rubrics: { good: { type: 'boolean', instructions: 'x' }, bad: { type: 'boolean', instructions: 'y' } },
      thresholds: { good: 0.9, bad: 0.9 },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    const r = result.perCase[0]!.rubrics;
    expect(r['good']!.passed).toBe(true);
    expect(r['bad']!.passed).toBe(false);
    expect(result.perCase[0]!.passed).toBe(false);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('score threshold uses the fractional value directly, not a rounded one', async () => {
    mockAnswering(() => ({ type: 'score', score: 1.49 }));
    const suite = defineEval({
      name: 'score-threshold',
      rubrics: { tone: { type: 'score', instructions: 'x', criteria: ['rude', 'neutral', 'warm'] } },
      thresholds: { tone: 1.5 },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    // 1.49 < 1.5 threshold -> fails, even though Math.round(1.49) would be 1
    // and this is nowhere near a "0" (rude) grade.
    expect(result.perCase[0]!.rubrics['tone']!.passed).toBe(false);
    expect(result.perCase[0]!.rubrics['tone']!.numericValue).toBeCloseTo(1.49);
  });

  it('choice threshold accepts a single string or a list', async () => {
    mockAnswering(() => ({ type: 'choice', choice: 'warm' }));
    const suite = defineEval({
      name: 'choice-threshold',
      rubrics: { tone: { type: 'choice', instructions: 'x', criteria: { rude: null, neutral: null, warm: null } } },
      thresholds: { tone: ['neutral', 'warm'] },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    expect(result.perCase[0]!.rubrics['tone']!.passed).toBe(true);
  });

  it('a rubric with no threshold is informational only (passed=null) and never fails the case', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 0.01 }));
    const suite = defineEval({
      name: 'no-threshold',
      rubrics: { info: { type: 'boolean', instructions: 'x' } },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    expect(result.perCase[0]!.rubrics['info']!.passed).toBeNull();
    expect(result.perCase[0]!.passed).toBe(true);
  });
});

describe('runEval — fractional precision', () => {
  it('preserves fractional scores end-to-end into per-rubric aggregates', async () => {
    let n = 0;
    const scores = [2.97, 1.01, 2.5];
    evaluateMock.mockImplementation(async (args: { questions: RubricMap }) => {
      const score = scores[n++]!;
      return {
        answers: { tone: { type: 'score', score } },
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      };
    });

    const suite = defineEval({
      name: 'fractional',
      rubrics: { tone: { type: 'score', instructions: 'x', criteria: ['a', 'b', 'c', 'd'] } },
      cases: [
        { id: 'c1', input: 'i', output: 'o' },
        { id: 'c2', input: 'i', output: 'o' },
        { id: 'c3', input: 'i', output: 'o' },
      ],
      // sequential so mock's `n` counter lines up with case order
    });

    const result = await runEval(suite, { skipAuthCheck: true, concurrency: 1 });

    expect(result.perCase.map((c) => c.rubrics['tone']!.numericValue)).toEqual([2.97, 1.01, 2.5]);
    const expectedMean = (2.97 + 1.01 + 2.5) / 3;
    expect(result.perRubric['tone']!.mean).toBeCloseTo(expectedMean, 10);
    // Never rounded to an integer along the way.
    expect(Number.isInteger(result.perRubric['tone']!.mean)).toBe(false);
  });
});

describe('runEval — generate', () => {
  it('calls case-level generate when output is omitted, and suite-level as fallback', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));
    const suite = defineEval({
      name: 'generate',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      generate: (input) => `suite-generated:${String(input)}`,
      cases: [
        { id: 'case-generate', input: 'x', generate: (input) => `case-generated:${String(input)}` },
        { id: 'suite-generate', input: 'y' },
      ],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    expect(result.perCase[0]!.output).toBe('case-generated:x');
    expect(result.perCase[1]!.output).toBe('suite-generated:y');
  });

  it('a generate() failure marks only that case as errored, others still run', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));
    const suite = defineEval({
      name: 'generate-fail',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: [
        {
          id: 'boom',
          input: 'x',
          generate: () => {
            throw new Error('generation failed');
          },
        },
        { id: 'ok', input: 'y', output: 'y-out' },
      ],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    expect(result.perCase[0]!.error).toMatch(/generation failed/);
    expect(result.perCase[0]!.passed).toBe(false);
    expect(result.perCase[1]!.error).toBeUndefined();
    expect(result.perCase[1]!.passed).toBe(true);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(2);
  });

  it('an evaluate() rejection marks the case errored without throwing the whole run', async () => {
    evaluateMock.mockRejectedValueOnce(new Error('gateway 500'));
    const suite = defineEval({
      name: 'evaluate-fail',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: [{ id: 'c', input: 'x', output: 'y' }],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    expect(result.perCase[0]!.error).toMatch(/gateway 500/);
    expect(result.success).toBe(false);
  });
});

describe('runEval — concurrency & ordering', () => {
  it('returns case results in input order regardless of completion order', async () => {
    // Case "slow" resolves after "fast" despite starting first, via a
    // deliberately reversed delay schedule.
    const delays: Record<string, number> = { slow: 30, fast: 0 };
    evaluateMock.mockImplementation(async (args: { state: { input: string } }) => {
      const id = args.state.input;
      await new Promise((r) => setTimeout(r, delays[id] ?? 0));
      return {
        answers: { a: { type: 'boolean', probability: 1 } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const suite = defineEval({
      name: 'ordering',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: [
        { id: 'case-slow', input: 'slow', output: 'o' },
        { id: 'case-fast', input: 'fast', output: 'o' },
      ],
    });

    const result = await runEval(suite, { skipAuthCheck: true, concurrency: 2 });
    expect(result.perCase.map((c) => c.id)).toEqual(['case-slow', 'case-fast']);
  });

  it('respects the concurrency limit (never more than N in flight)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    evaluateMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { answers: { a: { type: 'boolean', probability: 1 } }, usage: undefined };
    });

    const suite = defineEval({
      name: 'limit',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, input: 'i', output: 'o' })),
    });

    await runEval(suite, { skipAuthCheck: true, concurrency: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

describe('runEval — cost estimate', () => {
  it('computes estimatedCostUsd from summed usage and default pricing', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));
    const suite = defineEval({
      name: 'cost',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    const result = await runEval(suite, { skipAuthCheck: true });
    // mock usage: 100 input / 10 output tokens, default pricing $0.04/1M each
    const expected = (100 / 1_000_000) * 0.04 + (10 / 1_000_000) * 0.04;
    expect(result.estimatedCostUsd).toBeCloseTo(expected, 12);
  });

  it('honors custom pricing', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));
    const suite = defineEval({
      name: 'cost-custom',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    const result = await runEval(suite, {
      skipAuthCheck: true,
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    });
    const expected = (100 / 1_000_000) * 1 + (10 / 1_000_000) * 2;
    expect(result.estimatedCostUsd).toBeCloseTo(expected, 12);
  });
});

describe('runEval — auth preflight', () => {
  const originalGateway = process.env['AI_GATEWAY_API_KEY'];
  const originalOidc = process.env['VERCEL_OIDC_TOKEN'];

  beforeEach(() => {
    delete process.env['AI_GATEWAY_API_KEY'];
    delete process.env['VERCEL_OIDC_TOKEN'];
  });

  afterEach(() => {
    if (originalGateway !== undefined) {
      process.env['AI_GATEWAY_API_KEY'] = originalGateway;
    } else {
      delete process.env['AI_GATEWAY_API_KEY'];
    }
    if (originalOidc !== undefined) {
      process.env['VERCEL_OIDC_TOKEN'] = originalOidc;
    } else {
      delete process.env['VERCEL_OIDC_TOKEN'];
    }
  });

  it('throws a clear AuthError when neither env var is set', async () => {
    const suite = defineEval({
      name: 'auth',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    await expect(runEval(suite)).rejects.toBeInstanceOf(AuthError);
  });

  it('proceeds when AI_GATEWAY_API_KEY is set', async () => {
    mockAnswering(() => ({ type: 'boolean', probability: 1 }));
    process.env['AI_GATEWAY_API_KEY'] = 'test-key';
    const suite = defineEval({
      name: 'auth-ok',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      cases: [{ id: 'c', input: 'i', output: 'o' }],
    });
    await expect(runEval(suite)).resolves.toBeDefined();
  });
});
