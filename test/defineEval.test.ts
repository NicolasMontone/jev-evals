import { describe, expect, it } from 'vitest';
import { defineEval, InvalidSuiteError } from '../src/defineEval.js';

describe('defineEval', () => {
  it('accepts a well-formed suite', () => {
    const suite = defineEval({
      name: 'ok',
      rubrics: { a: { type: 'boolean', instructions: 'a?' } },
      cases: [{ id: 'c1', input: 'i', output: 'o' }],
    });
    expect(suite.name).toBe('ok');
  });

  it('rejects an empty name', () => {
    expect(() =>
      defineEval({ name: '', rubrics: { a: { type: 'boolean', instructions: 'a' } }, cases: [{ id: 'c', input: 'i', output: 'o' }] }),
    ).toThrow(InvalidSuiteError);
  });

  it('rejects a suite with no rubrics', () => {
    expect(() => defineEval({ name: 's', rubrics: {}, cases: [{ id: 'c', input: 'i', output: 'o' }] })).toThrow(
      InvalidSuiteError,
    );
  });

  it('rejects a score rubric with fewer than 2 criteria levels', () => {
    expect(() =>
      defineEval({
        name: 's',
        rubrics: { tone: { type: 'score', instructions: 'x', criteria: ['only-one'] } },
        cases: [{ id: 'c', input: 'i', output: 'o' }],
      }),
    ).toThrow(InvalidSuiteError);
  });

  it('rejects a choice rubric with empty criteria', () => {
    expect(() =>
      defineEval({
        name: 's',
        rubrics: { tone: { type: 'choice', instructions: 'x', criteria: {} } },
        cases: [{ id: 'c', input: 'i', output: 'o' }],
      }),
    ).toThrow(InvalidSuiteError);
  });

  it('rejects a case with no output and no generate function anywhere', () => {
    expect(() =>
      defineEval({
        name: 's',
        rubrics: { a: { type: 'boolean', instructions: 'a' } },
        cases: [{ id: 'c', input: 'i' }],
      }),
    ).toThrow(InvalidSuiteError);
  });

  it('accepts a case with no output when a suite-level generate exists', () => {
    const suite = defineEval({
      name: 's',
      rubrics: { a: { type: 'boolean', instructions: 'a' } },
      generate: (input) => `out:${String(input)}`,
      cases: [{ id: 'c', input: 'i' }],
    });
    expect(suite.cases[0]!.output).toBeUndefined();
  });

  it('rejects duplicate case ids', () => {
    expect(() =>
      defineEval({
        name: 's',
        rubrics: { a: { type: 'boolean', instructions: 'a' } },
        cases: [
          { id: 'dup', input: 'i', output: 'o' },
          { id: 'dup', input: 'i2', output: 'o2' },
        ],
      }),
    ).toThrow(InvalidSuiteError);
  });

  it('rejects a threshold for an unknown rubric', () => {
    expect(() =>
      defineEval({
        name: 's',
        rubrics: { a: { type: 'boolean', instructions: 'a' } },
        thresholds: { b: 0.5 } as never,
        cases: [{ id: 'c', input: 'i', output: 'o' }],
      }),
    ).toThrow(InvalidSuiteError);
  });

  it('rejects maxQuestionsPerCall < 1', () => {
    expect(() =>
      defineEval({
        name: 's',
        rubrics: { a: { type: 'boolean', instructions: 'a' } },
        cases: [{ id: 'c', input: 'i', output: 'o' }],
        maxQuestionsPerCall: 0,
      }),
    ).toThrow(InvalidSuiteError);
  });
});
