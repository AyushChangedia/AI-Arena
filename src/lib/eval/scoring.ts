import type { Metric, Score, ScoreDimension, Task, TaskCategory } from "@/lib/arena/types";
import { id } from "@/lib/arena/ids";

/**
 * Scoring.
 *
 *   score = 100 × Σ(weightᵢ × normalisedᵢ) / Σ(weight of AVAILABLE dimensions)
 *
 * The denominator is what implements redistribution: a dimension that could not
 * be measured — no provider for the judge, no failures to recover from, no cost
 * reported — contributes nothing and takes its weight out of the denominator,
 * rather than silently scoring zero.
 *
 * Raw metrics are stored separately from this. Re-weighting a category
 * re-derives history instead of destroying it.
 */

export interface NormaliserContext {
  task: Task;
}

interface DimensionSpec {
  label: string;
  /** Maps a raw measurement onto 0–1, where 1 is better. */
  normalise(value: number, ctx: NormaliserContext): number;
  /** Description shown in the score breakdown. */
  note?: string;
}

const DIMENSIONS: Record<string, DimensionSpec> = {
  "tests.passRate": { label: "Test pass rate", normalise: clamp01 },
  "rubric.score": { label: "Rubric", normalise: clamp01 },
  "rubric.coverage": { label: "Coverage", normalise: clamp01 },
  "sources.quality": { label: "Source quality", normalise: clamp01 },
  "recovery.rate": { label: "Recovery rate", normalise: clamp01 },
  "resilience.score": {
    label: "Resilience",
    note: "full marks for a clean run; recovered/total when something failed",
    normalise: clamp01,
  },
  "efficiency.score": { label: "Efficiency", normalise: clamp01 },
  "tools.reliability": { label: "Tool reliability", normalise: clamp01 },
  "quality.code": { label: "Code quality", normalise: clamp01 },
  "quality.reasoning": { label: "Reasoning quality", normalise: clamp01 },
  "cost.usd": {
    label: "Cost",
    note: "inverted against the task budget — cheaper scores higher",
    normalise: (value, ctx) => clamp01(1 - value / Math.max(0.0001, ctx.task.limits.budgetUsd)),
  },
  "latency.totalMs": {
    label: "Latency",
    note: "inverted against the task time limit",
    normalise: (value, ctx) => clamp01(1 - value / Math.max(1, ctx.task.limits.timeLimitMs)),
  },
};

/** Category defaults. A task may override them; the UI says when it has. */
export const CATEGORY_WEIGHTS: Record<TaskCategory, Record<string, number>> = {
  coding: {
    "tests.passRate": 0.4,
    "rubric.score": 0.2,
    "quality.code": 0.15,
    "efficiency.score": 0.1,
    "resilience.score": 0.1,
    "cost.usd": 0.05,
  },
  debugging: {
    "tests.passRate": 0.5,
    "rubric.score": 0.15,
    "resilience.score": 0.15,
    "efficiency.score": 0.15,
    "cost.usd": 0.05,
  },
  research: {
    "rubric.score": 0.3,
    "sources.quality": 0.25,
    "rubric.coverage": 0.2,
    "quality.reasoning": 0.15,
    "efficiency.score": 0.1,
  },
  data: {
    "tests.passRate": 0.45,
    "rubric.score": 0.2,
    "efficiency.score": 0.15,
    "resilience.score": 0.15,
    "cost.usd": 0.05,
  },
  ui: {
    "tests.passRate": 0.45,
    "rubric.score": 0.25,
    "quality.code": 0.1,
    "efficiency.score": 0.15,
    "cost.usd": 0.05,
  },
  reasoning: {
    "tests.passRate": 0.6,
    "rubric.score": 0.1,
    "efficiency.score": 0.15,
    "resilience.score": 0.1,
    "cost.usd": 0.05,
  },
  automation: {
    "tests.passRate": 0.45,
    "rubric.score": 0.2,
    "efficiency.score": 0.15,
    "resilience.score": 0.15,
    "cost.usd": 0.05,
  },
};

export function weightsFor(task: Task): Record<string, number> {
  const declared = task.evaluation.weights;
  if (declared && Object.keys(declared).length > 0) return declared;
  return CATEGORY_WEIGHTS[task.category];
}

export function dimensionLabel(key: string): string {
  return DIMENSIONS[key]?.label ?? key;
}

export function dimensionNote(key: string): string | undefined {
  return DIMENSIONS[key]?.note;
}

export interface ScoreInput {
  executionId: string;
  task: Task;
  metrics: Metric[];
  /** Dimensions an evaluator explicitly reported as unmeasurable, with reasons. */
  unavailable: { dimension: string; reason: string }[];
}

export function computeScore(input: ScoreInput): Score {
  const weights = weightsFor(input.task);
  const byKey = new Map(input.metrics.map((m) => [m.key, m]));
  const unavailableByKey = new Map(input.unavailable.map((u) => [u.dimension, u.reason]));

  const entries: {
    key: string;
    weight: number;
    raw: number | null;
    normalised: number | null;
    available: boolean;
    reason?: string;
  }[] = [];

  for (const [key, weight] of Object.entries(weights)) {
    const spec = DIMENSIONS[key];
    const measured = byKey.get(key);
    const explicitReason = unavailableByKey.get(key) ?? measured?.unavailableReason;

    if (!spec) {
      entries.push({ key, weight, raw: null, normalised: null, available: false, reason: "unknown dimension" });
      continue;
    }
    if (!measured || measured.value === null || !Number.isFinite(measured.value)) {
      entries.push({
        key,
        weight,
        raw: null,
        normalised: null,
        available: false,
        reason: explicitReason ?? "not measured",
      });
      continue;
    }
    entries.push({
      key,
      weight,
      raw: measured.value,
      normalised: clamp01(spec.normalise(measured.value, { task: input.task })),
      available: true,
    });
  }

  const availableWeight = entries.filter((e) => e.available).reduce((a, e) => a + e.weight, 0);

  const dimensions: ScoreDimension[] = entries.map((e) => {
    const effectiveWeight = e.available && availableWeight > 0 ? e.weight / availableWeight : 0;
    return {
      key: e.key,
      label: dimensionLabel(e.key),
      weight: e.weight,
      effectiveWeight,
      raw: e.raw,
      normalised: e.normalised,
      contribution: e.available ? (e.normalised ?? 0) * effectiveWeight * 100 : 0,
      available: e.available,
      ...(e.reason ? { reason: e.reason } : {}),
    };
  });

  const total = dimensions.reduce((a, d) => a + d.contribution, 0);

  return {
    id: id("score"),
    executionId: input.executionId,
    // A score with no measurable dimension at all is 0, not NaN.
    total: availableWeight > 0 ? round1(total) : 0,
    dimensions,
    createdAt: Date.now(),
  };
}

/** Draws within this margin are draws — a result decided by rounding is not one. */
export const DRAW_EPSILON = 0.5;

export type Decision = "A" | "B" | "draw" | "double_failure";

export function decideMatch(
  a: { score: number; testsPassRate: number | null; outcome: string },
  b: { score: number; testsPassRate: number | null; outcome: string },
): Decision {
  // Both agents failing every assertion does not crown one of them.
  const bothFailedTests =
    a.testsPassRate !== null && b.testsPassRate !== null && a.testsPassRate === 0 && b.testsPassRate === 0;
  const bothErrored = isFailure(a.outcome) && isFailure(b.outcome);
  if (bothFailedTests || bothErrored) return "double_failure";

  if (Math.abs(a.score - b.score) < DRAW_EPSILON) return "draw";
  return a.score > b.score ? "A" : "B";
}

function isFailure(outcome: string): boolean {
  return outcome === "provider_error" || outcome === "failed" || outcome === "cancelled";
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── "why the winner won" ───────────────────────────────────────────────────

export interface WinFactor {
  key: string;
  label: string;
  /** Signed difference in the raw measurement, winner minus loser. */
  delta: number;
  /** Human-readable delta, e.g. "+28.6%" or "-2.41s". */
  display: string;
  /** Raw values, winner then loser, for the "7/7 vs 5/7" style detail. */
  detail: string;
  /** Points of the final score gap this dimension accounts for. */
  contribution: number;
}

/**
 * Generated purely by subtracting two stored measurements. The generator has no
 * capacity to invent a figure — if nothing differs materially it returns an
 * empty list and the UI says so.
 */
export function explainWin(
  winner: { score: Score; metrics: Metric[] },
  loser: { score: Score; metrics: Metric[] },
): WinFactor[] {
  const loserMetrics = new Map(loser.metrics.map((m) => [m.key, m]));
  const loserDims = new Map(loser.score.dimensions.map((d) => [d.key, d]));
  const factors: WinFactor[] = [];

  for (const dim of winner.score.dimensions) {
    if (!dim.available || dim.raw === null) continue;
    const other = loserDims.get(dim.key);
    if (!other?.available || other.raw === null) continue;

    const delta = dim.raw - other.raw;
    if (delta === 0) continue;

    const contribution = dim.contribution - other.contribution;
    if (Math.abs(contribution) < 0.4) continue;

    const unit = winner.metrics.find((m) => m.key === dim.key)?.unit ?? "ratio";
    factors.push({
      key: dim.key,
      label: dim.label,
      delta,
      display: formatDelta(delta, unit),
      detail: `${formatValue(dim.raw, unit)} vs ${formatValue(other.raw, unit)}`,
      contribution,
    });
  }

  // Also surface material differences in raw counts that carry no direct weight
  // but explain the gap — tool calls, failures, steps.
  for (const key of ["tools.called", "tools.failed", "steps.used"]) {
    const mine = winner.metrics.find((m) => m.key === key);
    const theirs = loserMetrics.get(key);
    if (!mine || !theirs || mine.value === null || theirs.value === null) continue;
    const delta = mine.value - theirs.value;
    if (delta === 0) continue;
    const relative = theirs.value === 0 ? 1 : Math.abs(delta) / theirs.value;
    if (relative < 0.15) continue;
    factors.push({
      key,
      label: mine.label,
      delta,
      display: `${delta > 0 ? "+" : ""}${delta}`,
      detail: `${mine.value} vs ${theirs.value}`,
      contribution: 0,
    });
  }

  return factors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 5);
}

function formatDelta(delta: number, unit: Metric["unit"]): string {
  const sign = delta > 0 ? "+" : "";
  switch (unit) {
    case "ratio":
      return `${sign}${(delta * 100).toFixed(1)}%`;
    case "ms":
      return `${sign}${(delta / 1000).toFixed(2)}s`;
    case "usd":
      return `${sign}$${delta.toFixed(3)}`;
    default:
      return `${sign}${delta}`;
  }
}

function formatValue(value: number, unit: Metric["unit"]): string {
  switch (unit) {
    case "ratio":
      return `${(value * 100).toFixed(0)}%`;
    case "ms":
      return `${(value / 1000).toFixed(1)}s`;
    case "usd":
      return `$${value.toFixed(3)}`;
    default:
      return String(value);
  }
}
