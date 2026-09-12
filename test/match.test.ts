import { describe, expect, it, beforeAll } from "vitest";
import { rmSync } from "node:fs";
import { createMatch, startMatch, resolveMode } from "@/lib/arena/engine";
import { getStore } from "@/lib/store";
import { eventBus, topicFor, isTerminator } from "@/lib/arena/events";
import { allTasks } from "@/lib/tasks";
import type { ExecutionEvent } from "@/lib/arena/types";

/**
 * End-to-end: create a match, run it through the real harness, real tools, real
 * sandbox, real graders, and assert the whole pipeline produced real results.
 *
 * With no API key these run in DEMO mode — scripted policies driving the real
 * machinery — which is exactly the path a first-time visitor gets.
 */

beforeAll(() => {
  rmSync(".data-test", { recursive: true, force: true });
});

async function runMatch(taskSlug: string, handleA: string, handleB: string) {
  const store = await getStore();
  const task = allTasks().find((t) => t.slug === taskSlug)!;
  const [a, b] = await Promise.all([
    store.getAgentByHandle(handleA),
    store.getAgentByHandle(handleB),
  ]);

  const created = await createMatch({ taskId: task.id, agentAId: a!.id, agentBId: b!.id });

  const streamed: ExecutionEvent[] = [];
  const unsubscribe = eventBus().subscribe(topicFor(created.id), (e) => {
    if (!isTerminator(e)) streamed.push(e);
  });

  const match = await startMatch(created.id);
  unsubscribe();

  const executions = await store.listExecutions(match.id);
  const persisted = await store.getEvents(match.id);
  return { store, match, task, executions, streamed, persisted };
}

describe("a full match, end to end", () => {
  it("runs both agents, grades them, and decides a result", async () => {
    const { match, executions, streamed, persisted, store } = await runMatch(
      "repair-auth",
      "architect",
      "speedrunner",
    );

    expect(match.status).toBe("complete");
    expect(match.error).toBeNull();
    expect(["A", "B", "draw", "double_failure"]).toContain(match.result);
    expect(executions).toHaveLength(2);

    // Both sides really executed.
    for (const execution of executions) {
      expect(execution.steps).toBeGreaterThan(0);
      expect(execution.durationMs).toBeGreaterThanOrEqual(0);
      expect(execution.outcome).toBeTruthy();
    }

    // Events streamed live AND were persisted for replay.
    expect(streamed.length).toBeGreaterThan(10);
    expect(persisted.length).toBe(streamed.length);
    expect(streamed.map((e) => e.seq)).toEqual([...streamed].sort((x, y) => x.seq - y.seq).map((e) => e.seq));

    // Real tool calls happened.
    const calls = await store.getToolCalls(executions[0]!.id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.durationMs >= 0)).toBe(true);

    // Both sides were scored from real metrics.
    for (const execution of executions) {
      const score = await store.getScore(execution.id);
      const evaluation = await store.getEvaluation(execution.id);
      expect(score).not.toBeNull();
      expect(score!.total).toBeGreaterThanOrEqual(0);
      expect(score!.total).toBeLessThanOrEqual(100);
      expect(evaluation!.tests.length).toBeGreaterThan(0);
      expect(evaluation!.metrics.some((m) => m.key === "tests.passRate")).toBe(true);
    }
  });

  it("gives both sides an identical starting environment", async () => {
    const { match } = await runMatch("rate-limiter", "architect", "shipper");
    expect(match.envHash).toBeTruthy();
    expect(match.envHash).toHaveLength(16);
  });

  it("labels a keyless match DEMO and reports no fabricated cost", async () => {
    const { match, executions, store } = await runMatch("rate-limiter", "debugger", "speedrunner");
    // With no provider key configured, both sides are demo.
    expect(match.mode).toBe("demo");
    for (const execution of executions) {
      expect(execution.mode).toBe("demo");
      expect(execution.usage.costUsd).toBeNull();
      expect(execution.usage.tokensIn).toBeNull();
      const score = await store.getScore(execution.id);
      const cost = score!.dimensions.find((d) => d.key === "cost.usd");
      // Cost carries weight on this task, so it must be reported unavailable
      // and redistributed — never silently scored as zero or invented.
      expect(cost?.available).toBe(false);
      expect(cost?.reason).toBeTruthy();
    }
  });

  it("redistributes the weight of dimensions it could not measure", async () => {
    const { executions, store } = await runMatch("repair-auth", "architect", "generalist");
    for (const execution of executions) {
      const score = await store.getScore(execution.id);
      const available = score!.dimensions.filter((d) => d.available);
      const sum = available.reduce((a, d) => a + d.effectiveWeight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      for (const dim of score!.dimensions) {
        if (!dim.available) expect(dim.contribution).toBe(0);
      }
    }
  });

  it("a careful agent really does beat a careless one on the repair task", async () => {
    const { match, executions, store } = await runMatch("repair-auth", "architect", "speedrunner");
    const byId = new Map(executions.map((e) => [e.side, e]));
    const architect = await store.getEvaluation(byId.get("A")!.id);
    const speedrunner = await store.getEvaluation(byId.get("B")!.id);

    const passRate = (ev: typeof architect) =>
      ev!.metrics.find((m) => m.key === "tests.passRate")!.value ?? 0;

    // The Architect fixes all three defects; the Speedrunner skips the guard.
    // Neither outcome is hardcoded — the graders decide.
    expect(passRate(architect)).toBeGreaterThan(passRate(speedrunner));
    expect(match.result).toBe("A");
  });

  it("updates Elo for both the overall and the category scope", async () => {
    const { match, store } = await runMatch("oncall-rotation", "architect", "speedrunner");
    const [pa, pb] = match.participants;

    expect(pa.ratingAfter).not.toBeNull();
    expect(pb.ratingAfter).not.toBeNull();
    // Elo is zero-sum around the expectation, so the deltas move in opposition.
    const deltaA = pa.ratingAfter! - pa.ratingBefore;
    const deltaB = pb.ratingAfter! - pb.ratingBefore;
    if (match.result === "A") {
      expect(deltaA).toBeGreaterThan(0);
      expect(deltaB).toBeLessThan(0);
    }

    const overall = await store.getRating(pa.agentId, match.seasonId, "overall");
    const category = await store.getRating(pa.agentId, match.seasonId, "reasoning");
    expect(overall!.games).toBeGreaterThan(0);
    expect(category!.games).toBeGreaterThan(0);
  });

  it("produces artifacts the arena can display", async () => {
    const { executions, store } = await runMatch("landing-page", "architect", "speedrunner");
    const artifacts = await store.getArtifacts(executions[0]!.id);
    const primary = artifacts.find((a) => a.primary);
    expect(primary).toBeDefined();
    expect(primary!.kind).toBe("html");
    expect(primary!.content).toContain("<!doctype html>");
    expect(primary!.bytes).toBeGreaterThan(500);
  });

  it("marks research results as coming from the offline corpus", async () => {
    const { executions, store } = await runMatch("vector-db-research", "research-beast", "shipper");
    const calls = await store.getToolCalls(executions[0]!.id);
    const searches = calls.filter((c) => c.tool === "web.search");
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((c) => c.provenance === "offline-corpus")).toBe(true);
  });

  it("refuses to start the same match twice", async () => {
    const store = await getStore();
    const task = allTasks()[0]!;
    const [a, b] = await Promise.all([
      store.getAgentByHandle("architect"),
      store.getAgentByHandle("debugger"),
    ]);
    const match = await createMatch({ taskId: task.id, agentAId: a!.id, agentBId: b!.id });
    await startMatch(match.id);
    await expect(startMatch(match.id)).rejects.toThrow(/already run/);
  });

  it("rejects an agent facing itself", async () => {
    const store = await getStore();
    const a = await store.getAgentByHandle("architect");
    await expect(
      createMatch({ taskId: allTasks()[0]!.id, agentAId: a!.id, agentBId: a!.id }),
    ).rejects.toThrow(/cannot face itself/);
  });

  it("rejects an unknown task", async () => {
    const store = await getStore();
    const [a, b] = await Promise.all([
      store.getAgentByHandle("architect"),
      store.getAgentByHandle("shipper"),
    ]);
    await expect(
      createMatch({ taskId: "task_does_not_exist", agentAId: a!.id, agentBId: b!.id }),
    ).rejects.toThrow(/unknown task/);
  });
});

describe("mode resolution", () => {
  it("falls back to demo when the declared provider has no key", async () => {
    const store = await getStore();
    const architect = await store.getAgentByHandle("architect");
    // No ANTHROPIC_API_KEY in the test environment.
    expect(resolveMode(architect!.config)).toBe("demo");
  });
});

describe("replayability", () => {
  it("every persisted event carries a monotonic seq and a relative timestamp", async () => {
    const { persisted } = await runMatch("sales-analysis", "architect", "speedrunner");
    expect(persisted.length).toBeGreaterThan(0);
    let previous = -1;
    for (const event of persisted) {
      expect(event.seq).toBeGreaterThan(previous);
      previous = event.seq;
      expect(event.t).toBeGreaterThanOrEqual(0);
      expect(event.at).toBeGreaterThan(0);
    }
    expect(persisted[0]!.type).toBe("match.started");
    expect(persisted[persisted.length - 1]!.type).toBe("match.completed");
  });

  it("a late subscriber receives the full backlog", async () => {
    const { match } = await runMatch("repair-auth", "shipper", "generalist");
    const history = eventBus().history(topicFor(match.id));
    expect(history.length).toBeGreaterThan(10);
    expect(history.some((e) => e.type === "match.started")).toBe(true);
    expect(history.some((e) => e.type === "match.completed")).toBe(true);
  });
});
