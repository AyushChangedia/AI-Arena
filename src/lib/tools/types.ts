import type { z } from "zod";
import type { Vfs } from "@/lib/sandbox/vfs";
import type { VirtualShell } from "@/lib/sandbox/shell";
import type { CodeExecutor } from "@/lib/sandbox/vm";
import type { ToolSpec } from "@/lib/arena/types";

/** Everything a tool is allowed to touch. Deliberately small. */
export interface ToolContext {
  vfs: Vfs;
  shell: VirtualShell;
  executor: CodeExecutor;
  /** Aborted when the execution hits its wall-clock limit. */
  signal: AbortSignal;
  /** Remaining budget in USD. A tool that would exceed it is refused upstream. */
  budgetRemaining: number;
  /** Search backend. Falls back to the bundled corpus when unconfigured. */
  search: SearchBackend;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Full document body, available to `web.fetch`. */
  body?: string;
  /** Editorial quality signal used by the research rubric: 0–1. */
  authority?: number;
  publishedAt?: string;
}

export interface SearchBackend {
  readonly id: string;
  readonly provenance: "offline-corpus" | "live-web";
  readonly label: string;
  search(query: string, limit: number): Promise<SearchHit[]>;
  fetch(url: string): Promise<{ title: string; url: string; content: string } | null>;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. Truncated to the tool's output ceiling. */
  output: string;
  error: string | null;
  /** Rendered on the tool card when the data did not come from the live web. */
  provenance?: "offline-corpus" | "live-web";
  /** Extra structured detail for the UI (file paths touched, hit counts, …). */
  meta?: Record<string, unknown>;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  spec: ToolSpec;
  schema: S;
  execute(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * A tool with its argument type erased, for storage in the registry. The
 * registry validates against `schema` before dispatch, so the erased call site
 * is sound — `defineTool` is what keeps each definition strongly typed.
 */
export interface AnyTool {
  spec: ToolSpec;
  schema: z.ZodType;
  execute(args: never, ctx: ToolContext): Promise<ToolResult>;
}

/** Preserves full argument inference inside `execute` at the definition site. */
export function defineTool<S extends z.ZodType>(definition: ToolDefinition<S>): AnyTool {
  return definition as unknown as AnyTool;
}
