import { describe, expect, it } from "vitest";
import { runAgent } from "@/lib/arena/harness";
import { ProviderError } from "@/lib/agents/providers/types";
import type { ModelProvider, ProviderTurn } from "@/lib/agents/providers/types";
import { Vfs } from "@/lib/sandbox/vfs";
import { VirtualShell } from "@/lib/sandbox/shell";
import { NodeVmExecutor } from "@/lib/sandbox/vm";
import { OfflineCorpusBackend } from "@/lib/tools/web";
import { getTask } from "@/lib/tasks";
import type { AgentConfig, ExecutionEvent } from "@/lib/arena/types";

/**
 * The harness under adverse conditions. Every one of these is a failure mode a
 * real agent hits, and the arena has to measure rather than crash on.
 */

const executor = new NodeVmExecutor();
const task = getTask("repair-auth")!;

const config: AgentConfig = {
  name: "Test Agent",
  handle: "test-agent",
  tagline: "",
  description: "",
  model: { provider: "scripted", model: "test", label: "Test" },
  systemPrompt: "You are under test.",
  tools: ["file.read", "file.write", "file.list", "shell.exec", "code.run"],
  planning: "balanced",
  memory: "session",
  maxSteps: 12,
  timeLimitMs: 20_000,
  budgetUsd: 1,
  temperature: null,
  emblem: "TA",
  accent: "cyan",
};

/** A provider driven by a fixed script of turns. */
function scriptedProvider(turns: (() => ProviderTurn)[]): ModelProvider {
  let index = 0;
  return {
    id: "scripted",
    label: "Test",
    configured: true,
    models: [],
    async next(): Promise<ProviderTurn> {
      const turn = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      return turn();
    },
  };
}

const text = (t: string): ProviderTurn => ({
  text: t,
  toolCalls: [],
  done: true,
  usage: { tokensIn: null, tokensOut: null, costUsd: null },
});

const call = (name: string, args: Record<string, unknown>): ProviderTurn => ({
  text: "",
  toolCalls: [{ id: `c${Math.random()}`, name, args }],
  done: false,
  usage: { tokensIn: null, tokensOut: null, costUsd: null },
});

async function run(
  provider: ModelProvider,
  overrides: Partial<AgentConfig> = {},
  signal = new AbortController().signal,
) {
  const vfs = Vfs.fromSnapshot({ "/src/auth.js": "module.exports = {};", "/README.md": "hi" });
  const events: ExecutionEvent[] = [];
  let seq = 0;
  const result = await runAgent({
    matchId: "m1",
    executionId: "e1",
    side: "A",
    agentId: "a1",
    config: { ...config, ...overrides },
    task,
    mode: "demo",
    provider,
    vfs,
    shell: new VirtualShell({ vfs, executor }),
    executor,
    search: new OfflineCorpusBackend(),
    matchStartedAt: Date.now(),
    nextSeq: () => seq++,
    emit: (e) => events.push(e),
    signal,
  });
  return { result, events, vfs };
}

describe("harness lifecycle", () => {
  it("emits a start event and a completion event", async () => {
    const { result, events } = await run(scriptedProvider([() => text("done")]));
    expect(result.outcome).toBe("completed");
    expect(result.state).toBe("succeeded");
    expect(events[0]!.type).toBe("agent.started");
    expect(events.at(-1)!.type).toBe("agent.task_completed");
    expect(result.finalMessage).toBe("done");
  });

  it("runs tools and records every call", async () => {
    const { result } = await run(
      scriptedProvider([
        () => call("file.read", { path: "/README.md" }),
        () => call("file.write", { path: "/out.txt", content: "x" }),
        () => text("finished"),
      ]),
    );
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.every((c) => c.status === "ok")).toBe(true);
    expect(result.steps).toBe(3);
  });

  it("emits file events so the arena can show artifacts appearing", async () => {
    const { events } = await run(
      scriptedProvider([() => call("file.write", { path: "/src/auth.js", content: "// fixed" }), () => text("ok")]),
    );
    const modified = events.find((e) => e.type === "agent.file_modified");
    expect(modified).toBeDefined();
    expect(modified!.data?.path).toBe("/src/auth.js");
    expect(events.some((e) => e.type === "agent.artifact_created")).toBe(true);
  });
});

describe("harness limits", () => {
  it("stops at the step limit", async () => {
    const { result, events } = await run(
      scriptedProvider([() => call("file.list", {})]),
      { maxSteps: 4 },
    );
    expect(result.outcome).toBe("step_limit");
    expect(result.steps).toBe(4);
    expect(events.some((e) => e.type === "agent.limit_reached")).toBe(true);
  });

  it("stops at the task's step limit when it is lower than the agent's", async () => {
    const { result } = await run(scriptedProvider([() => call("file.list", {})]), { maxSteps: 999 });
    expect(result.steps).toBeLessThanOrEqual(task.limits.stepLimit);
  });

  it("stops when the wall clock runs out", async () => {
    const slow = scriptedProvider([
      () =>
        ({
          text: "",
          toolCalls: [{ id: "c", name: "file.list", args: {} }],
          done: false,
          usage: { tokensIn: null, tokensOut: null, costUsd: null },
        }) satisfies ProviderTurn,
    ]);
    const { result } = await run(slow, { timeLimitMs: 1, maxSteps: 999 });
    expect(["timeout", "step_limit"]).toContain(result.outcome);
  });

  it("stops when the budget is exhausted", async () => {
    const { result, events } = await run(
      scriptedProvider([
        () => ({
          text: "",
          toolCalls: [{ id: "c", name: "file.list", args: {} }],
          done: false,
          usage: { tokensIn: 100, tokensOut: 100, costUsd: 0.2 },
        }),
      ]),
      { budgetUsd: 0.5, maxSteps: 99 },
    );
    expect(result.outcome).toBe("budget_exceeded");
    expect(events.some((e) => e.label.includes("Budget"))).toBe(true);
  });

  it("accumulates reported usage and leaves it null when nothing was reported", async () => {
    const reported = await run(
      scriptedProvider([
        () => ({
          text: "",
          toolCalls: [{ id: "c", name: "file.list", args: {} }],
          done: false,
          usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
        }),
        () => ({ ...text("done"), usage: { tokensIn: 3, tokensOut: 2, costUsd: 0.002 } }),
      ]),
    );
    expect(reported.result.usage.tokensIn).toBe(13);
    expect(reported.result.usage.costUsd).toBeCloseTo(0.012, 6);

    const silent = await run(scriptedProvider([() => text("done")]));
    expect(silent.result.usage.tokensIn).toBeNull();
    expect(silent.result.usage.costUsd).toBeNull();
  });
});

describe("harness failure handling", () => {
  it("feeds a tool failure back and emits a recovery event", async () => {
    const { result, events } = await run(
      scriptedProvider([
        () => call("file.read", { path: "/missing.txt" }),
        () => call("file.read", { path: "/README.md" }),
        () => text("recovered"),
      ]),
    );
    expect(result.toolCalls[0]!.status).toBe("error");
    expect(result.toolCalls[1]!.status).toBe("ok");
    expect(events.some((e) => e.type === "agent.tool_failed")).toBe(true);
    expect(events.some((e) => e.type === "agent.recovery_started")).toBe(true);
    expect(events.some((e) => e.type === "agent.recovery_completed")).toBe(true);
    expect(result.outcome).toBe("completed");
  });

  it("treats a malformed tool call as a recoverable error, not a crash", async () => {
    const { result, events } = await run(
      scriptedProvider([() => call("file.write", { path: "/x.txt" }), () => text("gave up")]),
    );
    expect(result.toolCalls[0]!.status).toBe("error");
    expect(result.toolCalls[0]!.error).toMatch(/Invalid arguments/);
    expect(events.some((e) => e.type === "agent.tool_failed")).toBe(true);
    expect(result.outcome).toBe("completed");
  });

  it("refuses a tool the agent does not carry and says which are available", async () => {
    const { result } = await run(
      scriptedProvider([() => call("web.search", { query: "anything" }), () => text("done")]),
      { tools: ["file.read"] },
    );
    expect(result.toolCalls[0]!.status).toBe("error");
    expect(result.toolCalls[0]!.error).toMatch(/not available to you/);
    expect(result.toolCalls[0]!.error).toMatch(/file.read/);
  });

  it("ends cleanly when the agent has no usable tools at all", async () => {
    const { result, events } = await run(scriptedProvider([() => text("hi")]), {
      tools: ["web.search"],
    });
    expect(result.outcome).toBe("failed");
    expect(result.state).toBe("blocked");
    expect(result.error).toMatch(/does not overlap/);
    expect(events.some((e) => e.detail?.includes("this task allows"))).toBe(true);
  });

  it("reports a provider failure without losing the trace", async () => {
    const broken: ModelProvider = {
      id: "anthropic",
      label: "Anthropic",
      configured: false,
      models: [],
      async next() {
        throw new ProviderError("Anthropic is not configured", "not_configured");
      },
    };
    const { result, events } = await run(broken);
    expect(result.outcome).toBe("provider_error");
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/not configured/);
    expect(events.some((e) => e.label === "Provider not configured")).toBe(true);
    expect(events.length).toBeGreaterThan(1);
  });

  it("survives a provider that throws a plain error", async () => {
    const broken: ModelProvider = {
      id: "openai",
      label: "OpenAI",
      configured: true,
      models: [],
      async next(): Promise<ProviderTurn> {
        throw new TypeError("undefined is not a function");
      },
    };
    const { result } = await run(broken);
    expect(result.outcome).toBe("provider_error");
    expect(result.error).toMatch(/undefined is not a function/);
  });

  it("honours an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run(scriptedProvider([() => text("never")]), {}, controller.signal);
    expect(result.outcome).toBe("cancelled");
  });

  it("does not let a sandbox timeout take down the run", async () => {
    const { result } = await run(
      scriptedProvider([
        () => call("code.run", { source: "while (true) {}" }),
        () => text("moved on"),
      ]),
    );
    expect(result.toolCalls[0]!.status).toBe("error");
    expect(result.toolCalls[0]!.error).toMatch(/timeout|terminated/i);
    expect(result.outcome).toBe("completed");
  });
});

describe("harness artifacts", () => {
  it("collects files the agent produced and marks the task target primary", async () => {
    const { result } = await run(
      scriptedProvider([
        () => call("file.write", { path: "/src/auth.js", content: "// repaired" }),
        () => call("file.write", { path: "/notes.md", content: "notes" }),
        () => text("done"),
      ]),
    );
    const primary = result.artifacts.find((a) => a.primary);
    expect(primary?.path).toBe("/src/auth.js");
    expect(result.artifacts.map((a) => a.path)).toContain("/notes.md");
  });

  it("excludes scratch space from artifacts", async () => {
    const { result } = await run(
      scriptedProvider([() => call("code.run", { source: "module.exports = 1;" }), () => text("done")]),
    );
    expect(result.artifacts.some((a) => a.path.startsWith("/scratch/"))).toBe(false);
  });

  it("does not report an untouched seed file as an artifact", async () => {
    const { result } = await run(scriptedProvider([() => call("file.read", { path: "/README.md" }), () => text("x")]));
    expect(result.artifacts.some((a) => a.path === "/README.md")).toBe(false);
  });
});

describe("event integrity", () => {
  it("stamps every event with the side, a sequence and a relative time", async () => {
    const { events } = await run(
      scriptedProvider([() => call("file.read", { path: "/README.md" }), () => text("done")]),
    );
    let previous = -1;
    for (const event of events) {
      expect(event.matchId).toBe("m1");
      expect(event.side).toBe("A");
      expect(event.seq).toBeGreaterThan(previous);
      previous = event.seq;
      expect(event.t).toBeGreaterThanOrEqual(0);
    }
  });

  it("truncates enormous tool arguments out of the event payload", async () => {
    const huge = "x".repeat(50_000);
    const { events } = await run(
      scriptedProvider([() => call("file.write", { path: "/big.txt", content: huge }), () => text("done")]),
    );
    const called = events.find((e) => e.type === "agent.tool_called")!;
    const args = called.data?.args as Record<string, string | undefined>;
    const content = args.content ?? "";
    expect(content.length).toBeLessThan(1000);
    expect(content).toMatch(/\[50000 chars\]/);
  });
});
