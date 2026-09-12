import { describe, expect, it } from "vitest";
import { computeScore, decideMatch, explainWin, weightsFor, CATEGORY_WEIGHTS } from "@/lib/eval/scoring";
import { measureRecovery } from "@/lib/eval/trace";
import type { Metric, Task, ToolCall } from "@/lib/arena/types";
import { getTask } from "@/lib/tasks";

const task: Task = {
  ...getTask("repair-auth")!,
  evaluation: {
    evaluators: ["tests", "trace"],
    weights: { "tests.passRate": 0.5, "efficiency.score": 0.3, "cost.usd": 0.2 },
    weightsOverridden: true,
  },
  limits: { timeLimitMs: 100_000, stepLimit: 20, budgetUsd: 1 },
};

function metrics(values: Record<string, number | null>, reasons: Record<string, string> = {}): Metric[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    label: key,
    value,
    unit: key.includes("usd") ? "usd" : "ratio",
    ...(reasons[key] ? { unavailableReason: reasons[key] } : {}),
  }));
}

describe("computeScore", () => {
  it("weights normalised dimensions into a 0–100 total", () => {
    const score = computeScore({
      executionId: "e1",
      task,
      metrics: metrics({ "tests.passRate": 1, "efficiency.score": 1, "cost.usd": 0 }),
      unavailable: [],
    });
    expect(score.total).toBe(100);
  });

  it("scores zero when everything measurable is zero", () => {
    const score = computeScore({
      executionId: "e1",
      task,
      // cost.usd is inverted, so the full budget spent is the worst case.
      metrics: metrics({ "tests.passRate": 0, "efficiency.score": 0, "cost.usd": 1 }),
      unavailable: [],
    });
    expect(score.total).toBe(0);
  });

  it("inverts cost against the task budget", () => {
    const half = computeScore({
      executionId: "e1",
      task,
      metrics: metrics({ "tests.passRate": 0, "efficiency.score": 0, "cost.usd": 0.5 }),
      unavailable: [],
    });
    // 0.5 of a $1 budget normalises to 0.5, weighted 0.2 → 10 points.
    expect(half.total).toBeCloseTo(10, 5);
  });

  it("redistributes the weight of an unmeasurable dimension", () => {
    const score = computeScore({
      executionId: "e1",
      task,
      metrics: metrics(
        { "tests.passRate": 1, "efficiency.score": 1, "cost.usd": null },
        { "cost.usd": "not reported by the provider" },
      ),
      unavailable: [{ dimension: "cost.usd", reason: "not reported by the provider" }],
    });

    // Perfect on everything measurable is 100, not 80.
    expect(score.total).toBe(100);
    const cost = score.dimensions.find((d) => d.key === "cost.usd")!;
    expect(cost.available).toBe(false);
    expect(cost.contribution).toBe(0);
    expect(cost.effectiveWeight).toBe(0);
    expect(cost.reason).toBe("not reported by the provider");
  });

  it("keeps effective weights summing to one across available dimensions", () => {
    const score = computeScore({
      executionId: "e1",
      task,
      metrics: metrics({ "tests.passRate": 0.5, "efficiency.score": 0.5, "cost.usd": null }),
      unavailable: [{ dimension: "cost.usd", reason: "unreported" }],
    });
    const sum = score.dimensions.filter((d) => d.available).reduce((a, d) => a + d.effectiveWeight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("returns zero rather than NaN when nothing could be measured", () => {
    const score = computeScore({
      executionId: "e1",
      task,
      metrics: metrics({ "tests.passRate": null, "efficiency.score": null, "cost.usd": null }),
      unavailable: [],
    });
    expect(score.total).toBe(0);
    expect(Number.isNaN(score.total)).toBe(false);
  });

  it("clamps out-of-range measurements instead of letting them inflate a score", () => {
    const score = computeScore({
      executionId: "e1",
      task,
      metrics: metrics({ "tests.passRate": 4, "efficiency.score": -2, "cost.usd": 0 }),
      unavailable: [],
    });
    expect(score.total).toBeLessThanOrEqual(100);
    expect(score.dimensions.find((d) => d.key === "tests.passRate")!.normalised).toBe(1);
    expect(score.dimensions.find((d) => d.key === "efficiency.score")!.normalised).toBe(0);
  });

  it("marks an unknown dimension unavailable rather than crashing", () => {
    const odd: Task = {
      ...task,
      evaluation: { ...task.evaluation, weights: { "not.a.dimension": 1 } },
    };
    const score = computeScore({ executionId: "e1", task: odd, metrics: [], unavailable: [] });
    expect(score.total).toBe(0);
    expect(score.dimensions[0]!.reason).toMatch(/unknown dimension/);
  });
});

describe("category weights", () => {
  it("every category's defaults sum to 1", () => {
    for (const [category, weights] of Object.entries(CATEGORY_WEIGHTS)) {
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1), category).toBeLessThan(1e-9);
    }
  });

  it("falls back to the category defaults when a task declares none", () => {
    const bare: Task = { ...task, evaluation: { evaluators: [], weights: {}, weightsOverridden: false } };
    expect(weightsFor(bare)).toEqual(CATEGORY_WEIGHTS[bare.category]);
  });
});

describe("decideMatch", () => {
  const base = { testsPassRate: 0.5, outcome: "completed" };

  it("awards the higher score", () => {
    expect(decideMatch({ ...base, score: 90 }, { ...base, score: 80 })).toBe("A");
    expect(decideMatch({ ...base, score: 80 }, { ...base, score: 90 })).toBe("B");
  });

  it("calls anything inside the epsilon a draw", () => {
    expect(decideMatch({ ...base, score: 90.0 }, { ...base, score: 89.7 })).toBe("draw");
    expect(decideMatch({ ...base, score: 90.0 }, { ...base, score: 89.4 })).toBe("A");
  });

  it("refuses to crown a winner when both failed every assertion", () => {
    expect(
      decideMatch(
        { score: 30, testsPassRate: 0, outcome: "completed" },
        { score: 10, testsPassRate: 0, outcome: "completed" },
      ),
    ).toBe("double_failure");
  });

  it("refuses to crown a winner when both executions errored", () => {
    expect(
      decideMatch(
        { score: 20, testsPassRate: null, outcome: "provider_error" },
        { score: 5, testsPassRate: null, outcome: "failed" },
      ),
    ).toBe("double_failure");
  });

  it("still decides when only one side failed", () => {
    expect(
      decideMatch(
        { score: 60, testsPassRate: 0.8, outcome: "completed" },
        { score: 10, testsPassRate: 0, outcome: "failed" },
      ),
    ).toBe("A");
  });
});

describe("measureRecovery", () => {
  const call = (tool: string, path: string, status: "ok" | "error"): ToolCall => ({
    id: Math.random().toString(36),
    executionId: "e1",
    step: 1,
    tool,
    args: { path },
    status,
    durationMs: 1,
    output: "",
    error: status === "error" ? "boom" : null,
    costUsd: 0,
    startedAt: 0,
  });

  it("reports no failures as a null rate, not zero", () => {
    expect(measureRecovery([call("file.read", "/a", "ok")])).toEqual({
      failures: 0,
      recovered: 0,
      rate: null,
    });
  });

  it("counts a later success on the same target as a recovery", () => {
    const result = measureRecovery([call("file.read", "/a", "error"), call("file.read", "/a", "ok")]);
    expect(result).toEqual({ failures: 1, recovered: 1, rate: 1 });
  });

  it("does not count a success on a different target as a recovery", () => {
    const result = measureRecovery([call("file.read", "/a", "error"), call("file.read", "/b", "ok")]);
    expect(result).toEqual({ failures: 1, recovered: 0, rate: 0 });
  });

  it("collapses repeated failures on one target into a single failure", () => {
    const result = measureRecovery([
      call("file.read", "/a", "error"),
      call("file.read", "/a", "error"),
      call("file.read", "/a", "error"),
      call("file.read", "/a", "ok"),
    ]);
    expect(result).toEqual({ failures: 1, recovered: 1, rate: 1 });
  });

  it("reports a partial rate when only some failures were recovered", () => {
    const result = measureRecovery([
      call("file.read", "/a", "error"),
      call("file.read", "/a", "ok"),
      call("shell.exec", "/b", "error"),
    ]);
    expect(result.failures).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.rate).toBe(0.5);
  });
});

describe("explainWin", () => {
  const dim = (key: string, raw: number, contribution: number) => ({
    key,
    label: key,
    weight: 0.5,
    effectiveWeight: 0.5,
    raw,
    normalised: raw,
    contribution,
    available: true,
  });

  it("derives factors by subtracting stored measurements", () => {
    const factors = explainWin(
      {
        score: { id: "s1", executionId: "e1", total: 90, createdAt: 0, dimensions: [dim("tests.passRate", 1, 50)] },
        metrics: metrics({ "tests.passRate": 1 }),
      },
      {
        score: { id: "s2", executionId: "e2", total: 70, createdAt: 0, dimensions: [dim("tests.passRate", 0.7, 35)] },
        metrics: metrics({ "tests.passRate": 0.7 }),
      },
    );
    expect(factors).toHaveLength(1);
    expect(factors[0]!.display).toBe("+30.0%");
    expect(factors[0]!.detail).toBe("100% vs 70%");
  });

  it("returns nothing when the two sides are identical", () => {
    const identical = {
      score: { id: "s", executionId: "e", total: 80, createdAt: 0, dimensions: [dim("tests.passRate", 1, 50)] },
      metrics: metrics({ "tests.passRate": 1 }),
    };
    expect(explainWin(identical, { ...identical, score: { ...identical.score, id: "s2" } })).toEqual([]);
  });

  it("skips dimensions either side could not measure", () => {
    const factors = explainWin(
      {
        score: {
          id: "s1",
          executionId: "e1",
          total: 50,
          createdAt: 0,
          dimensions: [{ ...dim("cost.usd", 0.1, 10), available: false, raw: null, normalised: null }],
        },
        metrics: metrics({ "cost.usd": null }),
      },
      {
        score: { id: "s2", executionId: "e2", total: 40, createdAt: 0, dimensions: [dim("cost.usd", 0.5, 5)] },
        metrics: metrics({ "cost.usd": 0.5 }),
      },
    );
    expect(factors).toEqual([]);
  });
});
