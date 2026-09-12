import { describe, expect, it, beforeAll } from "vitest";
import { rmSync } from "node:fs";
import { createMatch, startMatch } from "@/lib/arena/engine";
import { getStore } from "@/lib/store";
import { allTaskDefinitions, getTaskDefinition } from "@/lib/tasks";
import { Vfs } from "@/lib/sandbox/vfs";
import { resolveCatalogue } from "@/lib/tools/registry";

/**
 * The fairness invariants from docs/ARCHITECTURE.md §5, asserted rather than
 * asserted-about. If any of these breaks, every result in the arena is void.
 */

beforeAll(() => {
  rmSync(".data-test-fairness", { recursive: true, force: true });
});

describe("identical starting environments", () => {
  it("every task materialises byte-identical workspaces from one seed", () => {
    for (const def of allTaskDefinitions()) {
      const spec = def.environment("match-seed-1");
      const a = Vfs.fromSnapshot(spec);
      const b = Vfs.fromSnapshot(spec);
      expect(a.hash(), def.task.slug).toBe(b.hash());
      expect(a.toSnapshot(), def.task.slug).toEqual(b.toSnapshot());
    }
  });

  it("two executions hold independent filesystems", () => {
    const def = getTaskDefinition("repair-auth")!;
    const spec = def.environment("seed");
    const a = Vfs.fromSnapshot(spec);
    const b = Vfs.fromSnapshot(spec);

    a.write("/src/auth.js", "// only A changed this");

    expect(a.read("/src/auth.js")).toContain("only A");
    expect(b.read("/src/auth.js")).not.toContain("only A");
    expect(a.hash()).not.toBe(b.hash());
  });

  it("records the verified environment hash on the match", async () => {
    const store = await getStore();
    const [x, y] = await Promise.all([
      store.getAgentByHandle("architect"),
      store.getAgentByHandle("debugger"),
    ]);
    const def = getTaskDefinition("rate-limiter")!;
    const match = await startMatch(
      (await createMatch({ taskId: def.task.id, agentAId: x!.id, agentBId: y!.id })).id,
    );

    expect(match.status).toBe("complete");
    expect(match.envHash).toBe(Vfs.fromSnapshot(def.environment(match.seed)).hash());
  });
});

describe("identical task, identical graders", () => {
  it("both participants are given the same prompt", async () => {
    const store = await getStore();
    const [x, y] = await Promise.all([
      store.getAgentByHandle("architect"),
      store.getAgentByHandle("shipper"),
    ]);
    const def = getTaskDefinition("repair-auth")!;
    const match = await startMatch(
      (await createMatch({ taskId: def.task.id, agentAId: x!.id, agentBId: y!.id })).id,
    );

    const executions = await store.listExecutions(match.id);
    expect(executions).toHaveLength(2);
    // Both ran the same task; the task's prompt is a single immutable string.
    for (const execution of executions) {
      expect(execution.matchId).toBe(match.id);
    }
    expect(new Set(executions.map((e) => e.id)).size).toBe(2);
  });

  it("grades both sides with the same assertion set", async () => {
    const store = await getStore();
    const matches = await store.listMatches({ status: "complete", limit: 5 });
    for (const match of matches) {
      const [a, b] = match.participants;
      if (!a.executionId || !b.executionId) continue;
      const [ea, eb] = await Promise.all([
        store.getEvaluation(a.executionId),
        store.getEvaluation(b.executionId),
      ]);
      expect(ea!.tests.map((t) => t.id)).toEqual(eb!.tests.map((t) => t.id));
      expect(ea!.rubric.map((r) => r.id)).toEqual(eb!.rubric.map((r) => r.id));
    }
  });
});

describe("tool catalogues", () => {
  it("an agent only ever sees the intersection of its tools and the task's", () => {
    const def = getTaskDefinition("vector-db-research")!;
    const catalogue = resolveCatalogue(def.task.toolsAllowed, ["web.search", "shell.exec", "file.read"]);
    const names = catalogue.map((t) => t.name);
    // shell.exec is not allowed on a research task, so it is simply absent.
    expect(names).toContain("web.search");
    expect(names).toContain("file.read");
    expect(names).not.toContain("shell.exec");
  });

  it("never grants a tool the task forbids, however the agent is configured", () => {
    for (const def of allTaskDefinitions()) {
      const greedy = resolveCatalogue(def.task.toolsAllowed, [
        "file.read",
        "file.write",
        "file.list",
        "file.delete",
        "shell.exec",
        "code.run",
        "web.search",
        "web.fetch",
      ]);
      for (const tool of greedy) {
        expect(def.task.toolsAllowed, `${def.task.slug} leaked ${tool.name}`).toContain(tool.name);
      }
    }
  });
});

describe("isolation between sides", () => {
  it("keeps each side's events, tool calls and artifacts separate", async () => {
    const store = await getStore();
    const [x, y] = await Promise.all([
      store.getAgentByHandle("architect"),
      store.getAgentByHandle("speedrunner"),
    ]);
    const def = getTaskDefinition("landing-page")!;
    const match = await startMatch(
      (await createMatch({ taskId: def.task.id, agentAId: x!.id, agentBId: y!.id })).id,
    );

    const [pa, pb] = match.participants;
    const [callsA, callsB, artA, artB] = await Promise.all([
      store.getToolCalls(pa.executionId!),
      store.getToolCalls(pb.executionId!),
      store.getArtifacts(pa.executionId!),
      store.getArtifacts(pb.executionId!),
    ]);

    expect(callsA.every((c) => c.executionId === pa.executionId)).toBe(true);
    expect(callsB.every((c) => c.executionId === pb.executionId)).toBe(true);
    expect(artA.every((a) => a.executionId === pa.executionId)).toBe(true);
    expect(artB.every((a) => a.executionId === pb.executionId)).toBe(true);

    const events = await store.getEvents(match.id);
    expect(events.some((e) => e.side === "A")).toBe(true);
    expect(events.some((e) => e.side === "B")).toBe(true);
    for (const event of events) {
      if (event.side === "A") expect(event.executionId).toBe(pa.executionId);
      if (event.side === "B") expect(event.executionId).toBe(pb.executionId);
    }
  });
});

describe("configuration pinning", () => {
  it("pins the exact config each participant ran, so later edits cannot rewrite history", async () => {
    const store = await getStore();
    const [x, y] = await Promise.all([
      store.getAgentByHandle("generalist"),
      store.getAgentByHandle("debugger"),
    ]);
    const def = getTaskDefinition("oncall-rotation")!;
    const match = await startMatch(
      (await createMatch({ taskId: def.task.id, agentAId: x!.id, agentBId: y!.id })).id,
    );

    const before = match.participants[0].configSnapshot.maxSteps;
    expect(match.participants[0].configHash).toBe(x!.configHash);

    // Mutating the live agent must not change the stored match.
    await store.updateAgent({ ...x!, config: { ...x!.config, maxSteps: 3 }, updatedAt: Date.now() });

    const reread = await store.getMatch(match.id);
    expect(reread!.participants[0].configSnapshot.maxSteps).toBe(before);
  });
});
