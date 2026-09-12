import type { Evaluator, EvaluationContext, EvaluatorResult } from "./types";
import { metric } from "./types";
import type { RubricCheckResult } from "@/lib/arena/types";
import { getTaskDefinition } from "@/lib/tasks";
import { CORPUS } from "@/lib/tasks/corpus";

/**
 * Deterministic qualitative checks: structural properties of the artifact that
 * are not pass/fail assertions but are still objectively measurable.
 *
 * Also computes `sources.quality` for research tasks — the mean editorial
 * authority of the sources actually cited, which is a real measurement over the
 * corpus rather than an opinion about the writing.
 */
export class RubricEvaluator implements Evaluator {
  readonly id = "rubric";
  readonly dimensions = [
    "rubric.checksTotal",
    "rubric.checksPassed",
    "rubric.score",
    "rubric.coverage",
    "sources.quality",
  ] as const;
  readonly deterministic = true;

  async evaluate(ctx: EvaluationContext): Promise<EvaluatorResult> {
    const def = getTaskDefinition(ctx.task.id);
    const checks = def?.rubric ?? [];

    const results: RubricCheckResult[] = [];
    for (const check of checks) {
      try {
        const outcome = await check.run({
          vfs: ctx.vfs,
          executor: ctx.executor,
          events: ctx.events,
          task: ctx.task,
        });
        results.push({
          id: check.id,
          name: check.name,
          weight: check.weight,
          passed: outcome.passed,
          score: clamp01(outcome.score),
          message: outcome.message,
        });
      } catch (e) {
        results.push({
          id: check.id,
          name: check.name,
          weight: check.weight,
          passed: false,
          score: 0,
          message: `check threw: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    const totalWeight = results.reduce((a, r) => a + r.weight, 0);
    const score = totalWeight === 0 ? null : results.reduce((a, r) => a + r.score * r.weight, 0) / totalWeight;
    const coverage = results.find((r) => r.id === "coverage")?.score ?? score;
    const sources = measureSourceQuality(ctx);

    return {
      status: results.length === 0 ? "unavailable" : "ok",
      reason: results.length === 0 ? "this task defines no rubric checks" : undefined,
      rubric: results,
      notes: results.filter((r) => !r.passed).map((r) => `${r.name}: ${r.message}`),
      metrics: [
        metric("rubric.checksTotal", "Rubric checks", results.length, "count"),
        metric("rubric.checksPassed", "Checks passed", results.filter((r) => r.passed).length, "count"),
        metric("rubric.score", "Rubric score", score, "ratio", score === null ? "no rubric checks" : undefined),
        metric("rubric.coverage", "Coverage", coverage ?? null, "ratio", coverage == null ? "not applicable" : undefined),
        metric(
          "sources.quality",
          "Source quality",
          sources.value,
          "ratio",
          sources.value === null ? sources.reason : undefined,
        ),
      ],
    };
  }
}

/**
 * Mean authority of the corpus documents the agent actually cited in its
 * artifacts. Null when the task is not source-based, which is reported rather
 * than defaulted to zero.
 */
function measureSourceQuality(ctx: EvaluationContext): { value: number | null; reason: string } {
  const usesWeb = ctx.task.toolsAllowed.includes("web.search");
  if (!usesWeb) return { value: null, reason: "not a source-based task" };

  const text = ctx.artifacts.map((a) => a.content).join("\n");
  if (!text) return { value: null, reason: "no artifact was produced" };

  const cited = CORPUS.filter((doc) => text.includes(doc.url));
  if (cited.length === 0) return { value: null, reason: "no known sources were cited" };

  const mean = cited.reduce((a, d) => a + d.authority, 0) / cited.length;
  return { value: clamp01(mean), reason: "" };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
