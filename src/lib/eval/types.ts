import type {
  Artifact,
  ExecutionEvent,
  Metric,
  RubricCheckResult,
  Task,
  TestResult,
  ToolCall,
} from "@/lib/arena/types";
import type { Vfs } from "@/lib/sandbox/vfs";
import type { CodeExecutor } from "@/lib/sandbox/vm";

/** The finished execution, as an evaluator sees it. */
export interface EvaluationContext {
  task: Task;
  vfs: Vfs;
  executor: CodeExecutor;
  events: ExecutionEvent[];
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  steps: number;
  stepLimit: number;
  durationMs: number;
  outcome: string;
  usage: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null };
}

export interface EvaluatorResult {
  status: "ok" | "unavailable" | "error";
  metrics: Metric[];
  tests?: TestResult[];
  rubric?: RubricCheckResult[];
  notes: string[];
  /** Present when status is not "ok". Shown verbatim in the UI. */
  reason?: string;
}

export interface Evaluator {
  readonly id: string;
  /** Metric keys this evaluator is responsible for. */
  readonly dimensions: readonly string[];
  readonly deterministic: boolean;
  evaluate(ctx: EvaluationContext): Promise<EvaluatorResult>;
}

export function metric(
  key: string,
  label: string,
  value: number | null,
  unit: Metric["unit"],
  unavailableReason?: string,
): Metric {
  return { key, label, value, unit, ...(unavailableReason ? { unavailableReason } : {}) };
}
