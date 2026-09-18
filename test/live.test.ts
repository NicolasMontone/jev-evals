import { describe, it, expect } from 'vitest';
import { defineEval } from '../src/defineEval.js';
import { runEval } from '../src/runEval.js';

const hasCreds = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);

describe.skipIf(!hasCreds)('live Jev call (AI Gateway)', () => {
  it('judges an obviously correct answer as passing', async () => {
    const suite = defineEval({
      name: 'live-smoke-test',
      rubrics: {
        correct: {
          type: 'boolean',
          instructions: 'Does the output correctly answer the input question?',
        },
      },
      thresholds: { correct: 0.5 },
      cases: [
        {
          id: 'capital-of-france',
          input: 'What is the capital of France?',
          output: 'The capital of France is Paris.',
        },
      ],
    });

    const result = await runEval(suite);
    expect(result.perCase).toHaveLength(1);
    const [caseResult] = result.perCase;
    expect(caseResult?.rubrics.correct?.passed).toBe(true);
    expect(result.success).toBe(true);
  }, 30_000);
});
