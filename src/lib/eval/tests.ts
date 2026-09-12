import type { Evaluator, EvaluationContext, EvaluatorResult } from "./types";
import { metric } from "./types";
import type { TestResult } from "@/lib/arena/types";
import { getTaskDefinition } from "@/lib/tasks";

/**
 * Deterministic and authoritative.
 *
 * Runs the task's own assertions against the finished workspace, executing the
 * agent's real code. A failing assertion is a failing task, and no other
 * evaluator can overrule it.
 */
export class AutomatedTestsEvaluator implements Evaluator {
  readonly id = "tests";
  readonly dimensions = ["tests.total", "tests.passed", "tests.failed", "tests.passRate"] as const;
  readonly deterministic = true;

  async evaluate(ctx: EvaluationContext): Promise<EvaluatorResult> {
    const def = getTaskDefinition(ctx.task.id);
    if (!def || def.tests.length === 0) {
      return {
        status: "unavailable",
        reason: "this task has no automated assertions",
        notes: [],
        metrics: [
          metric("tests.total", "Assertions", 0, "count"),
          metric("tests.passed", "Passed", null, "count", "this task has no automated assertions"),
          metric("tests.failed", "Failed", null, "count", "this task has no automated assertions"),
          metric("tests.passRate", "Test pass rate", null, "ratio", "this task has no automated assertions"),
        ],
      };
    }

    const results: TestResult[] = [];
    for (const test of def.tests) {
      const started = Date.now();
      try {
        const outcome = await test.run({
          vfs: ctx.vfs,
          executor: ctx.executor,
          events: ctx.events,
          task: ctx.task,
        });
        results.push({
          id: test.id,
          name: test.name,
          passed: outcome.passed,
          message: outcome.message,
          durationMs: Date.now() - started,
        });
      } catch (e) {
        // A grader that throws is a failure attributed to the agent's code, not
        // swallowed — but it must never take down the match.
        results.push({
          id: test.id,
          name: test.name,
          passed: false,
          message: `grader threw: ${e instanceof Error ? e.message : String(e)}`,
          durationMs: Date.now() - started,
        });
      }
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;

    return {
      status: "ok",
      tests: results,
      notes:
        failed === 0
          ? [`All ${results.length} assertions passed.`]
          : [`${failed} of ${results.length} assertions failed.`],
      metrics: [
        metric("tests.total", "Assertions", results.length, "count"),
        metric("tests.passed", "Passed", passed, "count"),
        metric("tests.failed", "Failed", failed, "count"),
        metric("tests.passRate", "Test pass rate", results.length ? passed / results.length : null, "ratio"),
      ],
    };
  }
}
