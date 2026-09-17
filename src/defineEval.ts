import type { EvalSuite, RubricMap } from './types.js';

export class InvalidSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSuiteError';
  }
}

/**
 * Defines an eval suite. This is mostly a typed identity function — it
 * exists so rubric/case shapes are inferred and validated up front (at
 * suite-definition time) rather than surfacing as a confusing failure deep
 * inside a jev call.
 */
export function defineEval<R extends RubricMap>(suite: EvalSuite<R>): EvalSuite<R> {
  if (!suite.name || !suite.name.trim()) {
    throw new InvalidSuiteError('EvalSuite.name must be a non-empty string.');
  }

  const rubricIds = Object.keys(suite.rubrics);
  if (rubricIds.length === 0) {
    throw new InvalidSuiteError(`Suite "${suite.name}" defines no rubrics.`);
  }

  for (const id of rubricIds) {
    const rubric = suite.rubrics[id as keyof R];
    if (!rubric) continue;
    validateRubric(suite.name, id, rubric);
  }

  if (!suite.cases || suite.cases.length === 0) {
    throw new InvalidSuiteError(`Suite "${suite.name}" defines no cases.`);
  }

  const seenIds = new Set<string>();
  for (const c of suite.cases) {
    if (!c.id || !c.id.trim()) {
      throw new InvalidSuiteError(`Suite "${suite.name}" has a case with an empty id.`);
    }
    if (seenIds.has(c.id)) {
      throw new InvalidSuiteError(`Suite "${suite.name}" has duplicate case id "${c.id}".`);
    }
    seenIds.add(c.id);
    if (c.output === undefined && !c.generate && !suite.generate) {
      throw new InvalidSuiteError(
        `Case "${c.id}" in suite "${suite.name}" has no \`output\` and no \`generate\` ` +
          `function (on the case or the suite) to produce one.`,
      );
    }
  }

  if (suite.thresholds) {
    for (const id of Object.keys(suite.thresholds)) {
      if (!(id in suite.rubrics)) {
        throw new InvalidSuiteError(
          `Suite "${suite.name}" has a threshold for unknown rubric "${id}".`,
        );
      }
    }
  }

  if (suite.maxQuestionsPerCall !== undefined && suite.maxQuestionsPerCall < 1) {
    throw new InvalidSuiteError('maxQuestionsPerCall must be >= 1.');
  }

  return suite;
}

function validateRubric(suiteName: string, id: string, rubric: RubricMap[string]): void {
  const where = `rubric "${id}" in suite "${suiteName}"`;
  switch (rubric.type) {
    case 'boolean':
      if (rubric.instructions === undefined) {
        throw new InvalidSuiteError(`${where}: boolean rubric requires \`instructions\`.`);
      }
      return;
    case 'choice': {
      const keys = Object.keys(rubric.criteria ?? {});
      if (keys.length === 0) {
        throw new InvalidSuiteError(
          `${where}: choice rubric requires a nonempty \`criteria\` map.`,
        );
      }
      return;
    }
    case 'score': {
      const levels = rubric.criteria ?? [];
      if (levels.length < 2) {
        throw new InvalidSuiteError(
          `${where}: score rubric requires >= 2 \`criteria\` levels (got ${levels.length}).`,
        );
      }
      return;
    }
    default: {
      const exhaustive: never = rubric;
      throw new InvalidSuiteError(`${where}: unknown rubric type ${JSON.stringify(exhaustive)}.`);
    }
  }
}
