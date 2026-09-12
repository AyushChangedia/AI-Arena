import type { Evaluator, EvaluationContext, EvaluatorResult } from "./types";
import { metric } from "./types";
import type { ToolCall } from "@/lib/arena/types";

/**
 * Measures the execution itself rather than its output. This is where the
 * arena's distinctive dimensions live, because none of them are visible in a
 * chat transcript.
 */
export class TraceEvaluator implements Evaluator {
  readonly id = "trace";
  readonly dimensions = [
    "steps.used",
    "tools.called",
    "tools.failed",
    "tools.reliability",
    "recovery.failures",
    "recovery.recovered",
    "recovery.rate",
    "resilience.score",
    "latency.totalMs",
    "latency.meanToolMs",
    "efficiency.score",
    "cost.usd",
    "tokens.in",
    "tokens.out",
  ] as const;
  readonly deterministic = true;

  async evaluate(ctx: EvaluationContext): Promise<EvaluatorResult> {
    const calls = ctx.toolCalls;
    const failed = calls.filter((c) => c.status === "error");
    const reliability = calls.length === 0 ? null : 1 - failed.length / calls.length;

    const recovery = measureRecovery(calls);
    const meanToolMs = calls.length === 0 ? null : calls.reduce((a, c) => a + c.durationMs, 0) / calls.length;

    const stepRatio = ctx.stepLimit > 0 ? clamp01(ctx.steps / ctx.stepLimit) : 1;
    const timeRatio = clamp01(ctx.durationMs / Math.max(1, ctx.task.limits.timeLimitMs));
    // Steps dominate: an agent that solves a task in 6 of 30 allowed steps is
    // efficient regardless of how long the provider took to answer.
    const efficiency = clamp01(1 - (stepRatio * 0.75 + timeRatio * 0.25));

    const notes: string[] = [];
    if (calls.length === 0) notes.push("No tools were called.");
    if (failed.length > 0) {
      notes.push(
        `${failed.length} tool call(s) failed; ${recovery.recovered} of ${recovery.failures} were recovered.`,
      );
    }
    if (ctx.usage.costUsd === null) {
      notes.push("Cost was not reported by the provider and is shown as unavailable rather than estimated.");
    }

    return {
      status: "ok",
      notes,
      metrics: [
        metric("steps.used", "Steps used", ctx.steps, "count"),
        metric("tools.called", "Tool calls", calls.length, "count"),
        metric("tools.failed", "Tool failures", failed.length, "count"),
        metric(
          "tools.reliability",
          "Tool reliability",
          reliability,
          "ratio",
          reliability === null ? "no tools were called" : undefined,
        ),
        metric("recovery.failures", "Failures encountered", recovery.failures, "count"),
        metric("recovery.recovered", "Failures recovered", recovery.recovered, "count"),
        metric(
          "recovery.rate",
          "Recovery rate",
          recovery.rate,
          "ratio",
          recovery.rate === null ? "no failures occurred" : undefined,
        ),
        // Scored separately from the raw rate above, and deliberately so.
        //
        // Treating "no failures" as UNMEASURABLE was a modelling error: it
        // redistributed the weight away from an agent that did everything right,
        // while an agent that broke something and fixed it scored 100% on the
        // same dimension. That makes failing profitable.
        //
        // Resilience asks the question that actually matters — "did failures
        // derail this run?" — for which zero failures is a full-marks answer.
        // The raw failure and recovery counts stay visible beside it.
        metric(
          "resilience.score",
          "Resilience",
          calls.length === 0 ? null : recovery.failures === 0 ? 1 : (recovery.rate ?? 0),
          "ratio",
          calls.length === 0 ? "no tools were called" : undefined,
        ),
        metric("latency.totalMs", "Total duration", ctx.durationMs, "ms"),
        metric(
          "latency.meanToolMs",
          "Mean tool latency",
          meanToolMs,
          "ms",
          meanToolMs === null ? "no tools were called" : undefined,
        ),
        metric("efficiency.score", "Efficiency", efficiency, "ratio"),
        metric(
          "cost.usd",
          "Cost",
          ctx.usage.costUsd,
          "usd",
          ctx.usage.costUsd === null ? "not reported by the provider" : undefined,
        ),
        metric(
          "tokens.in",
          "Input tokens",
          ctx.usage.tokensIn,
          "count",
          ctx.usage.tokensIn === null ? "not reported" : undefined,
        ),
        metric(
          "tokens.out",
          "Output tokens",
          ctx.usage.tokensOut,
          "count",
          ctx.usage.tokensOut === null ? "not reported" : undefined,
        ),
      ],
    };
  }
}

/**
 * Recovery, defined precisely.
 *
 * A failure is *recovered* when a later call to the same tool, against the same
 * primary target, succeeds. "Same primary target" means the same path, command,
 * query or url — the argument that identifies what the agent was trying to do.
 * When a failing call has no identifiable target, any later success with the
 * same tool counts.
 *
 * Consecutive failures against one target collapse into a single failure, so an
 * agent is not penalised extra for retrying, nor rewarded for retrying a lot.
 */
export function measureRecovery(calls: ToolCall[]): {
  failures: number;
  recovered: number;
  rate: number | null;
} {
  const openFailures = new Map<string, number>();
  let failures = 0;
  let recovered = 0;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const key = `${call.tool}::${targetOf(call) ?? "*"}`;

    if (call.status === "error") {
      if (!openFailures.has(key)) {
        failures += 1;
        openFailures.set(key, i);
      }
      continue;
    }

    if (openFailures.has(key)) {
      recovered += 1;
      openFailures.delete(key);
      continue;
    }
    // A success with no target matches any open failure on the same tool.
    if (targetOf(call) === null) {
      for (const openKey of openFailures.keys()) {
        if (openKey.startsWith(`${call.tool}::`)) {
          recovered += 1;
          openFailures.delete(openKey);
          break;
        }
      }
    }
  }

  return { failures, recovered, rate: failures === 0 ? null : recovered / failures };
}

function targetOf(call: ToolCall): string | null {
  for (const key of ["path", "command", "query", "url", "saveAs"]) {
    const value = call.args[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
