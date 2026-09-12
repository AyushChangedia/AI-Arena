/**
 * Tool registry.
 *
 * Every tool call the arena ever makes goes through `invoke`. Arguments are
 * schema-validated first; a validation failure becomes a normal tool error
 * returned to the agent, never a thrown exception. That matters: malformed
 * tool calls are a real failure mode that a good agent recovers from, and the
 * arena measures whether it does.
 */

import type { AnyTool, ToolContext, ToolResult } from "./types";
import type { ToolSpec } from "@/lib/arena/types";
import { fileTools } from "./file";
import { shellTool } from "./shell";
import { codeTool } from "./code";
import { webTools } from "./web";

const ALL: AnyTool[] = [...fileTools, shellTool, codeTool, ...webTools];

const BY_NAME = new Map<string, AnyTool>(ALL.map((t) => [t.spec.name, t]));

export const TOOL_NAMES = ALL.map((t) => t.spec.name);

export function allTools(): ToolSpec[] {
  return ALL.map((t) => t.spec);
}

export function getTool(name: string): AnyTool | undefined {
  return BY_NAME.get(name);
}

export function getToolSpec(name: string): ToolSpec | undefined {
  return BY_NAME.get(name)?.spec;
}

/**
 * The catalogue a given execution may use: the task's allowlist intersected
 * with the agent's own tool list. An agent asking for a tool the task forbids
 * simply does not see it — the asymmetry is shown in the pre-match panel.
 */
export function resolveCatalogue(taskAllowed: string[], agentTools: string[]): ToolSpec[] {
  const allowed = new Set(taskAllowed);
  const wanted = new Set(agentTools);
  return ALL.filter((t) => allowed.has(t.spec.name) && wanted.has(t.spec.name)).map((t) => t.spec);
}

export interface InvokeOutcome extends ToolResult {
  durationMs: number;
  costUsd: number;
  /** True when the failure was the agent's fault (bad args), not the arena's. */
  invalidArguments: boolean;
}

const MAX_OUTPUT_CHARS = 12_000;

export async function invoke(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<InvokeOutcome> {
  const started = Date.now();
  const tool = BY_NAME.get(name);

  if (!tool) {
    return {
      ok: false,
      output: "",
      error: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}`,
      durationMs: Date.now() - started,
      costUsd: 0,
      invalidArguments: true,
    };
  }

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .slice(0, 6)
      .join("; ");
    return {
      ok: false,
      output: "",
      error: `Invalid arguments for ${name} — ${issues}. Expected: ${describeParams(tool.spec)}`,
      durationMs: Date.now() - started,
      costUsd: 0,
      invalidArguments: true,
    };
  }

  if (ctx.budgetRemaining < tool.spec.cost) {
    return {
      ok: false,
      output: "",
      error: `Insufficient budget for ${name} (needs $${tool.spec.cost.toFixed(3)}, $${ctx.budgetRemaining.toFixed(3)} left).`,
      durationMs: Date.now() - started,
      costUsd: 0,
      invalidArguments: false,
    };
  }

  try {
    const result = await withTimeout(
      tool.execute(parsed.data as never, ctx),
      tool.spec.timeoutMs,
      `${name} exceeded its ${tool.spec.timeoutMs}ms timeout`,
    );
    return {
      ...result,
      output: clamp(result.output, MAX_OUTPUT_CHARS),
      durationMs: Date.now() - started,
      costUsd: tool.spec.cost,
      invalidArguments: false,
    };
  } catch (e) {
    return {
      ok: false,
      output: "",
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
      costUsd: tool.spec.cost,
      invalidArguments: false,
    };
  }
}

function describeParams(spec: ToolSpec): string {
  return (
    Object.entries(spec.parameters)
      .map(([k, p]) => `${k}: ${p.type}${p.required ? "" : "?"}`)
      .join(", ") || "no parameters"
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} characters]`;
}

