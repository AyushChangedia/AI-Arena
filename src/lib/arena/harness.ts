/**
 * The agent harness.
 *
 * One loop, shared by every agent, every provider, and both demo and live
 * matches: ask the provider for the next action, validate it, run it against
 * the real environment, record what happened, feed the result back, repeat
 * until the agent stops or a limit stops it.
 *
 * Everything the arena later measures — steps, tool reliability, recovery,
 * latency, artifacts — is observed here at the moment it happens.
 */

import type {
  AgentConfig,
  AgentState,
  Artifact,
  ArtifactKind,
  ExecutionEvent,
  ExecutionEventType,
  ExecutionMode,
  ExecutionOutcome,
  Side,
  Task,
  ToolCall,
  ToolSpec,
} from "./types";
import type { ChatMessage, ModelProvider } from "@/lib/agents/providers/types";
import { ProviderError } from "@/lib/agents/providers/types";
import type { Vfs } from "@/lib/sandbox/vfs";
import type { VirtualShell } from "@/lib/sandbox/shell";
import type { CodeExecutor } from "@/lib/sandbox/vm";
import type { SearchBackend } from "@/lib/tools/types";
import { invoke, resolveCatalogue } from "@/lib/tools/registry";
import { id } from "./ids";

export interface HarnessOptions {
  matchId: string;
  executionId: string;
  side: Side;
  agentId: string;
  config: AgentConfig;
  task: Task;
  mode: ExecutionMode;
  provider: ModelProvider;
  vfs: Vfs;
  shell: VirtualShell;
  executor: CodeExecutor;
  search: SearchBackend;
  /** Shared across both sides so the timeline has one origin. */
  matchStartedAt: number;
  /** Monotonic sequence shared across the match. */
  nextSeq: () => number;
  emit: (event: ExecutionEvent) => void;
  signal: AbortSignal;
}

export interface HarnessResult {
  outcome: ExecutionOutcome;
  /** The model that actually answered — a router may substitute a retired one. */
  servedModel: string;
  state: AgentState;
  steps: number;
  durationMs: number;
  toolCalls: ToolCall[];
  events: ExecutionEvent[];
  artifacts: Artifact[];
  usage: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null };
  finalMessage: string | null;
  error: string | null;
}

const MAX_TOKENS_PER_TURN = 4_000;

export async function runAgent(opts: HarnessOptions): Promise<HarnessResult> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.min(opts.config.timeLimitMs, opts.task.limits.timeLimitMs);
  const stepLimit = Math.min(opts.config.maxSteps, opts.task.limits.stepLimit);
  const budget = Math.min(opts.config.budgetUsd, opts.task.limits.budgetUsd);

  const catalogue: ToolSpec[] = resolveCatalogue(opts.task.toolsAllowed, opts.config.tools);
  const catalogueNames = new Set(catalogue.map((t) => t.name));

  const events: ExecutionEvent[] = [];
  const toolCalls: ToolCall[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: opts.task.prompt }];

  let steps = 0;
  let spent = 0;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let costUsd: number | null = null;
  let finalMessage: string | null = null;
  let outcome: ExecutionOutcome | null = null;
  let error: string | null = null;
  /** What is actually answering, which a router may change mid-run. */
  let servedModel = opts.config.model.model;
  let state: AgentState = "idle";
  /** Tracked explicitly: `state` is mutated through a closure, so narrowing it is unsound. */
  let recovering = false;

  const emit = (
    type: ExecutionEventType,
    label: string,
    extra: Partial<ExecutionEvent> = {},
  ): ExecutionEvent => {
    const now = Date.now();
    const event: ExecutionEvent = {
      id: id("evt"),
      seq: opts.nextSeq(),
      matchId: opts.matchId,
      executionId: opts.executionId,
      agentId: opts.agentId,
      side: opts.side,
      type,
      at: now,
      t: now - opts.matchStartedAt,
      step: steps,
      label,
      ...extra,
    };
    events.push(event);
    opts.emit(event);
    return event;
  };

  const setState = (next: AgentState, label?: string) => {
    if (state === next) return;
    state = next;
    emit("agent.state_changed", label ?? next.toUpperCase(), { state: next });
  };

  emit("agent.started", `${opts.config.name} entered the arena`, {
    state: "planning",
    data: {
      model: opts.config.model.label,
      provider: opts.config.model.provider,
      mode: opts.mode,
      tools: [...catalogueNames],
      stepLimit,
      budgetUsd: budget,
    },
  });
  setState("planning");

  if (catalogue.length === 0) {
    emit("agent.task_failed", "No tools available for this task", {
      status: "error",
      detail: `${opts.config.name} requests [${opts.config.tools.join(", ")}] but this task allows [${opts.task.toolsAllowed.join(", ")}].`,
    });
    setState("blocked");
    return finish("failed", "the agent's tool list does not overlap the task's allowed tools");
  }

  // ── the loop ───────────────────────────────────────────────────────────────
  while (true) {
    if (opts.signal.aborted) {
      outcome = "cancelled";
      break;
    }
    if (Date.now() >= deadline) {
      emit("agent.limit_reached", `Time limit reached (${fmtMs(deadline - startedAt)})`, {
        status: "error",
      });
      outcome = "timeout";
      break;
    }
    if (steps >= stepLimit) {
      emit("agent.limit_reached", `Step limit reached (${stepLimit} steps)`, { status: "error" });
      outcome = "step_limit";
      break;
    }
    if (spent >= budget) {
      emit("agent.limit_reached", `Budget exhausted ($${budget.toFixed(2)})`, { status: "error" });
      outcome = "budget_exceeded";
      break;
    }

    steps += 1;
    setState(steps === 1 ? "planning" : "thinking");
    emit(steps === 1 ? "agent.planning" : "agent.thinking", steps === 1 ? "Planning approach" : `Deciding step ${steps}`);

    let turn;
    try {
      turn = await opts.provider.next({
        model: servedModel,
        systemPrompt: buildSystemPrompt(opts.config, opts.task, catalogue),
        messages,
        tools: catalogue,
        temperature: opts.config.temperature,
        maxTokens: MAX_TOKENS_PER_TURN,
        signal: opts.signal,
      });
    } catch (e) {
      const pe = e instanceof ProviderError ? e : null;
      error = e instanceof Error ? e.message : String(e);
      // The label is what a viewer reads on the agent panel, so it names the
      // actual problem. "Model unavailable" and "Rate limited" are things the
      // user can act on; "Provider error" is not.
      emit("agent.task_failed", providerFailureLabel(pe), { status: "error", detail: error });
      setState("failed");
      outcome = pe?.kind === "aborted" ? "cancelled" : "provider_error";
      break;
    }

    // A router may answer on a different model than the one asked for, which
    // happens routinely when a free id is retired. Announced once, so the run is
    // never silently attributed to a model that did not produce it.
    if (turn.modelUsed && turn.modelUsed !== servedModel) {
      servedModel = turn.modelUsed;
      emit("agent.message", `Running on ${turn.modelUsed}`, {
        detail: `${opts.config.model.model} was not available, so the provider served ${turn.modelUsed} instead.`,
      });
    }

    // Accumulate usage. Demo runs report nothing, and nothing is invented.
    if (turn.usage.tokensIn !== null) tokensIn = (tokensIn ?? 0) + turn.usage.tokensIn;
    if (turn.usage.tokensOut !== null) tokensOut = (tokensOut ?? 0) + turn.usage.tokensOut;
    if (turn.usage.costUsd !== null) {
      costUsd = (costUsd ?? 0) + turn.usage.costUsd;
      spent += turn.usage.costUsd;
    }

    if (turn.text.trim()) {
      emit("agent.message", truncate(turn.text.trim(), 300), { detail: turn.text.trim() });
    }

    if (turn.done || turn.toolCalls.length === 0) {
      finalMessage = turn.text.trim() || null;
      outcome = "completed";
      break;
    }

    messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      setState(toolState(call.name));

      emit("agent.tool_called", `${call.name}`, {
        tool: call.name,
        status: "pending",
        detail: summariseArgs(call.args),
        data: { args: redact(call.args), ...pickMeta(call.args) },
      });

      if (!catalogueNames.has(call.name)) {
        // Asking for a tool this execution does not have is a real failure the
        // agent has to notice and route around.
        const message = `Tool "${call.name}" is not available to you. Available: ${[...catalogueNames].join(", ")}`;
        recordToolCall(call.name, call.args, false, "", message, 0, 0);
        emit("agent.tool_failed", `${call.name} — unavailable`, {
          tool: call.name,
          status: "error",
          detail: message,
        });
        messages.push({
          role: "tool",
          content: message,
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
        });
        recovering = true;
        setState("recovering");
        emit("agent.recovery_started", `Recovering from unavailable tool ${call.name}`);
        continue;
      }

      // Clear the change log so the drain below reports only this tool's writes.
      opts.vfs.drainChanges();

      const result = await invoke(call.name, call.args, {
        vfs: opts.vfs,
        shell: opts.shell,
        executor: opts.executor,
        signal: opts.signal,
        budgetRemaining: Math.max(0, budget - spent),
        search: opts.search,
      });

      spent += result.costUsd;
      recordToolCall(
        call.name,
        call.args,
        result.ok,
        result.output,
        result.error,
        result.durationMs,
        result.costUsd,
        result.provenance,
      );

      // File changes become their own events so the arena can show artifacts
      // appearing as they are produced.
      for (const change of opts.vfs.drainChanges()) {
        if (change.kind === "deleted") continue;
        emit(change.kind === "created" ? "agent.file_created" : "agent.file_modified", change.path, {
          tool: call.name,
          status: "ok",
          data: { path: change.path, bytes: change.bytes },
        });
        if (opts.task.targetArtifact && change.path === opts.task.targetArtifact.path) {
          emit("agent.artifact_created", `Artifact updated — ${change.path}`, {
            status: "ok",
            data: { path: change.path, kind: opts.task.targetArtifact.kind },
          });
        }
      }

      const wasRecovering = recovering;

      if (result.ok) {
        emit("agent.tool_completed", `${call.name}`, {
          tool: call.name,
          status: "ok",
          durationMs: result.durationMs,
          detail: truncate(result.output, 200),
          data: {
            ...pickMeta(call.args),
            ...(result.meta ?? {}),
            ...(result.provenance ? { provenance: result.provenance } : {}),
          },
        });
        if (call.name === "shell.exec") {
          emit("agent.command_executed", String(call.args.command ?? ""), {
            tool: call.name,
            status: "ok",
            durationMs: result.durationMs,
          });
        }
        if (wasRecovering) {
          recovering = false;
          emit("agent.recovery_completed", `Recovered — ${call.name} succeeded`, { tool: call.name, status: "ok" });
        }
        messages.push({
          role: "tool",
          content: result.output || "(no output)",
          toolCallId: call.id,
          toolName: call.name,
        });
        setState("executing");
      } else {
        emit("agent.tool_failed", `${call.name} — ${truncate(result.error ?? "failed", 80)}`, {
          tool: call.name,
          status: "error",
          durationMs: result.durationMs,
          detail: result.error ?? undefined,
          data: { invalidArguments: result.invalidArguments, ...pickMeta(call.args) },
        });
        if (call.name === "shell.exec") {
          emit("agent.command_failed", String(call.args.command ?? ""), {
            tool: call.name,
            status: "error",
            durationMs: result.durationMs,
          });
        }
        messages.push({
          role: "tool",
          content: `ERROR: ${result.error ?? "tool failed"}${result.output ? `\n${result.output}` : ""}`,
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
        });
        recovering = true;
        setState("recovering");
        emit("agent.recovery_started", `Recovering from ${call.name} failure`, { tool: call.name });
      }
    }
  }

  return finish(outcome ?? "failed", error);

  // ── helpers ──────────────────────────────────────────────────────────────

  function recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    ok: boolean,
    output: string,
    err: string | null,
    durationMs: number,
    cost: number,
    provenance?: "offline-corpus" | "live-web",
  ) {
    toolCalls.push({
      id: id("call"),
      executionId: opts.executionId,
      step: steps,
      tool,
      args: redact(args),
      status: ok ? "ok" : "error",
      durationMs,
      output: truncate(output, 4_000),
      error: err,
      costUsd: cost,
      startedAt: Date.now() - durationMs,
      ...(provenance ? { provenance } : {}),
    });
  }

  function finish(result: ExecutionOutcome, failure: string | null): HarnessResult {
    const succeeded = result === "completed";
    if (succeeded) {
      setState("succeeded");
      emit("agent.task_completed", `${opts.config.name} finished in ${steps} steps`, {
        status: "ok",
        data: { steps, durationMs: Date.now() - startedAt },
      });
    } else if (state !== "failed" && state !== "blocked") {
      setState("failed");
      emit("agent.task_failed", labelForOutcome(result), { status: "error", detail: failure ?? undefined });
    }

    return {
      outcome: result,
      servedModel,
      state,
      steps,
      durationMs: Date.now() - startedAt,
      toolCalls,
      events,
      artifacts: collectArtifacts(opts.vfs, opts.task, opts.executionId),
      usage: { tokensIn, tokensOut, costUsd },
      finalMessage,
      error: failure,
    };
  }
}

// ─── prompt ─────────────────────────────────────────────────────────────────

export function buildSystemPrompt(config: AgentConfig, task: Task, catalogue: ToolSpec[]): string {
  const planning =
    config.planning === "deep"
      ? "Plan thoroughly before acting. Inspect the environment first, then act deliberately."
      : config.planning === "balanced"
        ? "Form a short plan, then act. Re-plan when something surprises you."
        : "Act immediately. Prefer doing over planning, and correct course from results.";

  return [
    config.systemPrompt.trim(),
    "",
    "## Environment",
    "You are working in an isolated in-memory workspace. There is no host filesystem, no",
    "network beyond the tools listed, and no package registry. Paths are absolute from /.",
    "",
    "## Tools",
    catalogue.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
    "",
    "## Limits",
    `- ${Math.min(config.maxSteps, task.limits.stepLimit)} steps maximum`,
    `- ${Math.round(Math.min(config.timeLimitMs, task.limits.timeLimitMs) / 1000)}s wall clock`,
    `- $${Math.min(config.budgetUsd, task.limits.budgetUsd).toFixed(2)} budget`,
    "",
    "## How you are graded",
    task.successConditions.map((c) => `- ${c}`).join("\n"),
    "",
    "## Operating rules",
    planning,
    "A failed tool call is information, not a dead end: read the error and adapt.",
    "When the work is done, stop calling tools and reply with a short summary of what you",
    "produced and where it is. Do not claim to have done something you did not do.",
  ].join("\n");
}

// ─── artifacts ──────────────────────────────────────────────────────────────

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  html: "html",
  htm: "html",
  js: "code",
  ts: "code",
  css: "code",
  json: "json",
  csv: "csv",
  md: "markdown",
  txt: "text",
};

export function artifactKindFor(path: string): ArtifactKind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return KIND_BY_EXT[ext] ?? "text";
}

/**
 * Files the agent produced or changed, excluding scratch space. The task's
 * declared target is always included and marked primary.
 */
function collectArtifacts(vfs: Vfs, task: Task, executionId: string): Artifact[] {
  const seeded = new Set(task.seedFiles.map((f) => f.path));
  const target = task.targetArtifact?.path;
  const out: Artifact[] = [];

  for (const file of vfs.entries()) {
    if (file.path.startsWith("/scratch/") || file.path.startsWith("/.arena/")) continue;
    const isTarget = file.path === target;
    const changed = !seeded.has(file.path) || file.revisions > 1;
    if (!isTarget && !changed) continue;

    out.push({
      id: id("art"),
      executionId,
      path: file.path,
      kind: isTarget && task.targetArtifact ? task.targetArtifact.kind : artifactKindFor(file.path),
      bytes: file.bytes,
      content: file.content.length > 120_000 ? `${file.content.slice(0, 120_000)}\n... [truncated]` : file.content,
      createdAt: file.createdAt,
      primary: isTarget,
    });
  }

  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.path.localeCompare(b.path));
}

// ─── small helpers ──────────────────────────────────────────────────────────

function toolState(tool: string): AgentState {
  if (tool.startsWith("web.")) return "searching";
  if (tool === "shell.exec" || tool === "code.run") return "executing";
  return "executing";
}

function labelForOutcome(outcome: ExecutionOutcome): string {
  switch (outcome) {
    case "timeout":
      return "Out of time";
    case "step_limit":
      return "Out of steps";
    case "budget_exceeded":
      return "Out of budget";
    case "provider_error":
      return "Provider failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Failed";
  }
}

function summariseArgs(args: Record<string, unknown>): string {
  const primary = args.path ?? args.command ?? args.query ?? args.url ?? args.saveAs;
  if (typeof primary === "string") return truncate(primary, 120);
  const keys = Object.keys(args);
  return keys.length ? `${keys.length} argument(s)` : "no arguments";
}

/** The primary argument, surfaced for the UI and for recovery attribution. */
function pickMeta(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["path", "command", "query", "url", "saveAs"]) {
    const value = args[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Large argument values are summarised — a 40KB file body is not telemetry. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 600) {
      out[key] = `${value.slice(0, 600)}… [${value.length} chars]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * A short, honest headline for a provider failure.
 *
 * A free-tier model that has been retired or is momentarily saturated is the
 * most likely failure in a zero-cost setup, and it is not the same thing as a
 * bad key or a bug. The match still completes and is still graded — the agent
 * simply scores what it managed before the provider stopped answering.
 */
function providerFailureLabel(error: ProviderError | null): string {
  switch (error?.kind) {
    case "not_configured":
      return "Provider not configured";
    case "unavailable":
      return "Model unavailable";
    case "rate_limit":
      return "Rate limited";
    case "auth":
      return "Provider rejected the key";
    case "network":
      return "Provider unreachable";
    case "aborted":
      return "Run cancelled";
    default:
      return "Provider error";
  }
}
