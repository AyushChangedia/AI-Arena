import type { Evaluator, EvaluationContext, EvaluatorResult } from "./types";
import { metric } from "./types";
import { liveProviders } from "@/lib/agents/providers/registry";
import type { ModelProvider } from "@/lib/agents/providers/types";

/**
 * The only non-deterministic evaluator, and the most constrained one.
 *
 * Rules it operates under:
 *  - It never sees the agent's name, handle, model, or provider. Blinded.
 *  - It never sees the other agent's work. No comparison, no anchoring.
 *  - It scores narrow qualitative dimensions only, and cannot touch
 *    `tests.passRate`. A failing assertion is a failing task whatever it thinks.
 *  - With no provider configured it returns `unavailable` and its weight is
 *    redistributed. It never guesses a score.
 */
export class LlmJudgeEvaluator implements Evaluator {
  readonly id = "judge";
  readonly dimensions = ["quality.code", "quality.reasoning"] as const;
  readonly deterministic = false;

  constructor(private provider?: ModelProvider) {}

  private pick(): ModelProvider | null {
    if (this.provider?.configured) return this.provider;
    for (const p of liveProviders().values()) if (p.configured) return p;
    return null;
  }

  async evaluate(ctx: EvaluationContext): Promise<EvaluatorResult> {
    const needed = neededDimensions(ctx);
    if (needed.length === 0) {
      return { status: "unavailable", reason: "this task has no judged dimensions", notes: [], metrics: [] };
    }

    const provider = this.pick();
    if (!provider) {
      const reason = "no model provider is configured — weight redistributed";
      return {
        status: "unavailable",
        reason,
        notes: [`LLM judge skipped: ${reason}.`],
        metrics: needed.map((d) => metric(d, labelFor(d), null, "ratio", reason)),
      };
    }

    const primary = ctx.artifacts.find((a) => a.primary) ?? ctx.artifacts[0];
    if (!primary) {
      const reason = "no artifact was produced to judge";
      return {
        status: "unavailable",
        reason,
        notes: [],
        metrics: needed.map((d) => metric(d, labelFor(d), null, "ratio", reason)),
      };
    }

    const model = provider.models[0]?.id;
    if (!model) {
      const reason = `${provider.label} exposes no model for judging`;
      return { status: "unavailable", reason, notes: [], metrics: needed.map((d) => metric(d, labelFor(d), null, "ratio", reason)) };
    }

    try {
      const turn = await provider.next({
        model,
        systemPrompt: JUDGE_SYSTEM,
        messages: [
          {
            role: "user",
            content: buildJudgePrompt(ctx, primary.path, primary.content, needed),
          },
        ],
        tools: [],
        temperature: 0,
        maxTokens: 700,
        signal: AbortSignal.timeout(30_000),
      });

      const parsed = parseScores(turn.text, needed);
      if (!parsed) {
        const reason = "the judge did not return parseable scores";
        return {
          status: "error",
          reason,
          notes: [reason],
          metrics: needed.map((d) => metric(d, labelFor(d), null, "ratio", reason)),
        };
      }

      return {
        status: "ok",
        notes: parsed.notes,
        metrics: needed.map((d) => metric(d, labelFor(d), parsed.scores[d] ?? null, "ratio",
          parsed.scores[d] === undefined ? "the judge did not score this dimension" : undefined)),
      };
    } catch (e) {
      const reason = `judge call failed: ${e instanceof Error ? e.message : String(e)}`;
      return {
        status: "error",
        reason,
        notes: [reason],
        metrics: needed.map((d) => metric(d, labelFor(d), null, "ratio", reason)),
      };
    }
  }
}

const JUDGE_SYSTEM = `You are grading one artifact against one brief.

You are NOT told who produced it, what model made it, or what any other attempt looked
like. Do not speculate about any of that.

Score only the dimensions you are asked for, each from 0.0 to 1.0. Be strict: 0.5 is
competent-but-unremarkable, 0.9+ is work you would merge without comment.

Respond with JSON only, no prose outside it:
{"scores": {"<dimension>": 0.0}, "notes": ["one short observation", "..."]}`;

function buildJudgePrompt(
  ctx: EvaluationContext,
  path: string,
  content: string,
  dimensions: string[],
): string {
  return [
    `TASK BRIEF:\n${ctx.task.prompt}`,
    "",
    `SUCCESS CONDITIONS:\n${ctx.task.successConditions.map((c) => `- ${c}`).join("\n")}`,
    "",
    `DIMENSIONS TO SCORE: ${dimensions.join(", ")}`,
    dimensions.includes("quality.code")
      ? "quality.code — clarity, correctness of approach, error handling, absence of dead or duplicated logic."
      : "",
    dimensions.includes("quality.reasoning")
      ? "quality.reasoning — whether the argument is supported, whether trade-offs are weighed, whether the conclusion follows."
      : "",
    "",
    `ARTIFACT (${path}):`,
    "```",
    content.slice(0, 12_000),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

function neededDimensions(ctx: EvaluationContext): string[] {
  const weights = ctx.task.evaluation.weights;
  return ["quality.code", "quality.reasoning"].filter((d) => (weights[d] ?? 0) > 0);
}

function labelFor(dimension: string): string {
  return dimension === "quality.code" ? "Code quality" : "Reasoning quality";
}

function parseScores(
  text: string,
  dimensions: string[],
): { scores: Record<string, number>; notes: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const doc = JSON.parse(text.slice(start, end + 1)) as {
      scores?: Record<string, unknown>;
      notes?: unknown;
    };
    const scores: Record<string, number> = {};
    for (const d of dimensions) {
      const value = doc.scores?.[d];
      if (typeof value === "number" && Number.isFinite(value)) {
        scores[d] = Math.max(0, Math.min(1, value));
      }
    }
    if (Object.keys(scores).length === 0) return null;
    const notes = Array.isArray(doc.notes)
      ? doc.notes.filter((n): n is string => typeof n === "string").slice(0, 4)
      : [];
    return { scores, notes };
  } catch {
    return null;
  }
}
