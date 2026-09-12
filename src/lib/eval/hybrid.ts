import type { Evaluation, Metric, RubricCheckResult, TestResult } from "@/lib/arena/types";
import type { Evaluator, EvaluationContext } from "./types";
import { AutomatedTestsEvaluator } from "./tests";
import { RubricEvaluator } from "./rubric";
import { TraceEvaluator } from "./trace";
import { LlmJudgeEvaluator } from "./judge";
import { id } from "@/lib/arena/ids";

/**
 * Composes the applicable evaluators into one flat metric bag.
 *
 * Failure containment matters here: one evaluator throwing marks its own
 * dimensions unavailable and the match still completes and scores. A broken
 * judge must never cost a good agent its result.
 */
export function defaultEvaluators(): Evaluator[] {
  return [new AutomatedTestsEvaluator(), new RubricEvaluator(), new TraceEvaluator(), new LlmJudgeEvaluator()];
}

export interface HybridResult {
  evaluation: Evaluation;
  /** Dimensions that could not be measured, for the scorer's redistribution. */
  unavailable: { dimension: string; reason: string }[];
}

export async function evaluateExecution(
  ctx: EvaluationContext,
  executionId: string,
  evaluators: Evaluator[] = defaultEvaluators(),
): Promise<HybridResult> {
  const metrics: Metric[] = [];
  const tests: TestResult[] = [];
  const rubric: RubricCheckResult[] = [];
  const notes: string[] = [];
  const unavailable: { evaluator: string; dimension: string; reason: string }[] = [];

  for (const evaluator of evaluators) {
    try {
      const result = await evaluator.evaluate(ctx);
      metrics.push(...result.metrics);
      if (result.tests) tests.push(...result.tests);
      if (result.rubric) rubric.push(...result.rubric);
      notes.push(...result.notes);

      if (result.status !== "ok") {
        const reason = result.reason ?? "unavailable";
        for (const dimension of evaluator.dimensions) {
          if (metrics.some((m) => m.key === dimension && m.value !== null)) continue;
          unavailable.push({ evaluator: evaluator.id, dimension, reason });
        }
      }
      // A metric reported with an explicit reason is unavailable even when the
      // evaluator as a whole succeeded — "no failures to recover from", say.
      for (const m of result.metrics) {
        if (m.value === null && m.unavailableReason) {
          unavailable.push({ evaluator: evaluator.id, dimension: m.key, reason: m.unavailableReason });
        }
      }
    } catch (e) {
      const reason = `${evaluator.id} evaluator failed: ${e instanceof Error ? e.message : String(e)}`;
      notes.push(reason);
      for (const dimension of evaluator.dimensions) {
        unavailable.push({ evaluator: evaluator.id, dimension, reason });
      }
    }
  }

  const evaluation: Evaluation = {
    id: id("eval"),
    executionId,
    metrics: dedupeMetrics(metrics),
    tests,
    rubric,
    notes,
    unavailable: dedupeUnavailable(unavailable),
    createdAt: Date.now(),
  };

  return { evaluation, unavailable: evaluation.unavailable.map(({ dimension, reason }) => ({ dimension, reason })) };
}

/** Later evaluators win only if they actually measured something. */
function dedupeMetrics(metrics: Metric[]): Metric[] {
  const byKey = new Map<string, Metric>();
  for (const m of metrics) {
    const existing = byKey.get(m.key);
    if (!existing || (existing.value === null && m.value !== null)) byKey.set(m.key, m);
  }
  return [...byKey.values()];
}

function dedupeUnavailable(
  items: { evaluator: string; dimension: string; reason: string }[],
): { evaluator: string; dimension: string; reason: string }[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.dimension)) return false;
    seen.add(i.dimension);
    return true;
  });
}
