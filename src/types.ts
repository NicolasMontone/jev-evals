/**
 * Types for jev-evals.
 *
 * The `Rubric`/`Question` shapes here mirror the VERIFIED `ai` package
 * `experimental_evaluate` API exactly (see README for the source). Do not
 * add fields that aren't part of that API — this package is a thin,
 * opinionated harness around it, not a reinterpretation of it.
 */

/** A JSON-serializable object, matching the AI SDK's `JSONObject`. */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type JSONObject = { [key: string]: JSONValue };

/**
 * `Input` matches the `Input` type accepted by jev's `instructions` and
 * `criteria` fields, and by `evaluate()`'s `state`: a string, a JSON object,
 * or a JSON array.
 */
export type Input = string | JSONObject | JSONValue[];

// ---------------------------------------------------------------------------
// Rubric (Question) definitions — one per rubric in a suite.
// ---------------------------------------------------------------------------

export interface BooleanRubric {
  type: 'boolean';
  instructions: Input;
  criteria?: {
    true?: Input | null;
    false?: Input | null;
  };
}

export interface ChoiceRubric {
  type: 'choice';
  instructions: Input;
  /** Nonempty map of option name -> description. Key order is significant:
   * it is treated as low-to-high when a rubric represents an ordered scale
   * (see `choiceOrdinal` in aggregate.ts). */
  criteria: Record<string, Input | null>;
}

export interface ScoreRubric {
  type: 'score';
  instructions: Input;
  /** >= 2 levels, ordered LOWEST to HIGHEST. */
  criteria: (Input | null)[];
}

export type Rubric = BooleanRubric | ChoiceRubric | ScoreRubric;

export type RubricType = Rubric['type'];

export type RubricMap = Record<string, Rubric>;

// ---------------------------------------------------------------------------
// Answers — exactly the shapes returned by jev.
// ---------------------------------------------------------------------------

export interface BooleanAnswer {
  type: 'boolean';
  /** P(true). ALWAYS present. */
  probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Fractional, in [0, levels - 1]. Never round this. */
  score: number;
  /** Keyed '0', '1', '2', ... */
  probabilities?: Record<string, number>;
}

export type Answer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * A threshold for a rubric. For `boolean` and `score` rubrics this is the
 * minimum acceptable numeric value (probability, or raw fractional score on
 * the rubric's own [0, levels-1] scale). For `choice` rubrics it is the
 * accepted choice (or set of accepted choices).
 */
export type Threshold = number | string | string[];

export type ThresholdMap<R extends RubricMap> = Partial<Record<keyof R, Threshold>>;

// ---------------------------------------------------------------------------
// Suite / case definitions
// ---------------------------------------------------------------------------

export interface EvalCase {
  id: string;
  input: Input;
  /**
   * Pre-computed output to judge. Omit it (and supply `generate` on the
   * case or the suite) to have the harness produce it for you.
   */
  output?: Input;
  /** Optional reference/gold answer, passed to jev alongside input/output. */
  expected?: Input;
  /**
   * Per-case override for producing `output` when it isn't supplied.
   * Falls back to the suite-level `generate` when omitted.
   */
  generate?: (input: Input, evalCase: EvalCase) => Promise<Input> | Input;
  /** Free-form metadata carried through into results, untouched. */
  metadata?: JSONObject;
}

export interface EvalSuite<R extends RubricMap = RubricMap> {
  name: string;
  rubrics: R;
  thresholds?: ThresholdMap<R>;
  cases: EvalCase[];
  /**
   * Suite-level default for producing a case's `output` when the case
   * doesn't supply one directly. A case's own `generate` takes priority.
   */
  generate?: (input: Input, evalCase: EvalCase) => Promise<Input> | Input;
  /**
   * Safety valve for suites with unusually many rubrics: jev answers every
   * rubric for a case in ONE round trip, which is the whole point (cost and
   * latency scale with round trips, not with question count). But a single
   * request still has to fit the provider's context/response budget, so if
   * a suite defines more rubrics than this, the harness splits that case's
   * rubrics across multiple `evaluate()` calls (run in parallel) rather
   * than failing outright. Keep suites under this limit to get the one
   * -round-trip cost/latency profile the package is built around.
   * Default: 40.
   */
  maxQuestionsPerCall?: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface RubricResult {
  rubricId: string;
  type: RubricType;
  answer: Answer;
  /**
   * A single numeric projection of `answer`, used for thresholds and
   * aggregation:
   *  - boolean -> probability (0..1)
   *  - score   -> the raw fractional score, e.g. 2.97 (0..levels-1)
   *  - choice  -> the chosen option's position among `criteria`'s keys,
   *               normalized to 0..1 (0 = first key, 1 = last key). This
   *               only makes sense as an ordinal when the rubric's criteria
   *               are themselves ordered low-to-high, which is a
   *               convention this package encourages but can't enforce.
   */
  numericValue: number;
  /** null when the rubric has no threshold configured (informational only). */
  passed: boolean | null;
  threshold?: Threshold;
}

export interface CaseResult {
  id: string;
  input: Input;
  output: Input | undefined;
  expected?: Input;
  metadata?: JSONObject;
  rubrics: Record<string, RubricResult>;
  /** True iff every thresholded rubric passed. True (vacuously) if none. */
  passed: boolean;
  usage?: UsageTotals;
  warnings?: unknown[];
  /** Set instead of `rubrics` succeeding, if generation or evaluation threw. */
  error?: string;
}

export interface RubricAggregate {
  rubricId: string;
  type: RubricType;
  /** Mean of `numericValue` across cases that produced an answer for this rubric. */
  mean: number;
  min: number;
  max: number;
  /** Fraction of cases that passed this rubric's threshold; null if no threshold. */
  passRate: number | null;
  /** Number of cases with an answer for this rubric (errors excluded). */
  count: number;
}

export interface RunResult {
  suite: string;
  /** Number of cases where every thresholded rubric passed (and no error). */
  passed: number;
  /** Number of cases with a threshold failure or a runtime error. */
  failed: number;
  total: number;
  /** `failed === 0`. What the CLI uses for its exit code. */
  success: boolean;
  perCase: CaseResult[];
  perRubric: Record<string, RubricAggregate>;
  usage: UsageTotals;
  estimatedCostUsd: number;
  ms: number;
  timestamp: string;
  /** Carried through so `compareRuns` can label rubrics without the suite. */
  rubricTypes: Record<string, RubricType>;
}

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

export type DeltaStatus = 'regressed' | 'improved' | 'unchanged' | 'new' | 'removed';

export interface RubricDelta {
  rubricId: string;
  type: RubricType | undefined;
  baselineMean: number | null;
  currentMean: number | null;
  /** currentMean - baselineMean (null when either side is missing). */
  diff: number | null;
  status: DeltaStatus;
}

export interface CompareResult {
  baselineSuite: string;
  currentSuite: string;
  tolerance: number;
  deltas: RubricDelta[];
  regressed: RubricDelta[];
  improved: RubricDelta[];
  unchanged: RubricDelta[];
  /** True iff at least one rubric regressed beyond tolerance. */
  hasRegression: boolean;
}
