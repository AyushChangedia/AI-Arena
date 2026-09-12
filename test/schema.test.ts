import { describe, expect, it } from "vitest";
import {
  agentConfigSchema,
  createAgentSchema,
  createMatchSchema,
  blankAgentConfig,
  LIMITS,
} from "@/lib/agents/schema";
import { deriveProfile, seededRng } from "@/lib/agents/policies/types";
import { hashOf, slugify, stableStringify } from "@/lib/arena/ids";
import { rateLimit, resetRateLimits } from "@/lib/server/rate-limit";

const valid = { ...blankAgentConfig(), name: "The Archivist", emblem: "AR" };

describe("agent configuration validation", () => {
  it("accepts a well-formed configuration", () => {
    expect(agentConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a name that is too short or too long", () => {
    expect(agentConfigSchema.safeParse({ ...valid, name: "x" }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...valid, name: "x".repeat(41) }).success).toBe(false);
  });

  it("requires a substantial system prompt", () => {
    const result = agentConfigSchema.safeParse({ ...valid, systemPrompt: "do stuff" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/at least 20 characters/);
    }
  });

  it("requires at least one tool", () => {
    expect(agentConfigSchema.safeParse({ ...valid, tools: [] }).success).toBe(false);
  });

  it("rejects a tool that does not exist", () => {
    const result = agentConfigSchema.safeParse({ ...valid, tools: ["file.read", "rm.rf"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /Unknown tool/.test(i.message))).toBe(true);
    }
  });

  it("bounds steps, time and budget", () => {
    expect(agentConfigSchema.safeParse({ ...valid, maxSteps: 0 }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...valid, maxSteps: 999 }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...valid, timeLimitMs: 1000 }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...valid, budgetUsd: 1000 }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...valid, maxSteps: LIMITS.maxSteps.max }).success).toBe(true);
  });

  it("rejects an unknown provider", () => {
    const result = agentConfigSchema.safeParse({
      ...valid,
      model: { provider: "acme", model: "x", label: "X" },
    });
    expect(result.success).toBe(false);
  });

  it("normalises the emblem to upper case and caps it at two characters", () => {
    const result = agentConfigSchema.safeParse({ ...valid, emblem: "ab" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.emblem).toBe("AB");
    expect(agentConfigSchema.safeParse({ ...valid, emblem: "abc" }).success).toBe(false);
  });

  it("allows a null temperature but rejects an out-of-range one", () => {
    expect(agentConfigSchema.safeParse({ ...valid, temperature: null }).success).toBe(true);
    expect(agentConfigSchema.safeParse({ ...valid, temperature: 0.7 }).success).toBe(true);
    expect(agentConfigSchema.safeParse({ ...valid, temperature: 9 }).success).toBe(false);
  });

  it("defaults visibility on create", () => {
    const result = createAgentSchema.safeParse({ config: valid });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.visibility).toBe("public");
  });

  it("reports every invalid field rather than stopping at the first", () => {
    const result = agentConfigSchema.safeParse({ ...valid, name: "", tools: [], maxSteps: 0 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("match creation validation", () => {
  it("requires a task and two agents", () => {
    expect(createMatchSchema.safeParse({ taskId: "t", agentAId: "a", agentBId: "b" }).success).toBe(true);
    expect(createMatchSchema.safeParse({ taskId: "", agentAId: "a", agentBId: "b" }).success).toBe(false);
    expect(createMatchSchema.safeParse({ taskId: "t", agentAId: "a" }).success).toBe(false);
  });
});

describe("identity helpers", () => {
  it("hashes configuration content, not key order", () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });

  it("ignores undefined fields when hashing", () => {
    expect(hashOf({ a: 1, b: undefined })).toBe(hashOf({ a: 1 }));
  });

  it("stringifies nested structures stably", () => {
    expect(stableStringify({ z: [3, { b: 1, a: 2 }], a: 1 })).toBe(
      stableStringify({ a: 1, z: [3, { a: 2, b: 1 }] }),
    );
  });

  it("slugifies names safely and never returns empty", () => {
    expect(slugify("The Archivist!")).toBe("the-archivist");
    expect(slugify("  ---  ")).toBe("agent");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("policy profile derivation", () => {
  it("maps planning depth onto exploration and recovery, as documented", () => {
    const base = blankAgentConfig();
    const deep = deriveProfile({ ...base, planning: "deep", handle: "d" }, "seed");
    const balanced = deriveProfile({ ...base, planning: "balanced", handle: "b" }, "seed");
    const reactive = deriveProfile({ ...base, planning: "reactive", handle: "r" }, "seed");

    expect(deep.explore).toBeGreaterThan(balanced.explore);
    expect(balanced.explore).toBeGreaterThan(reactive.explore);
    expect(deep.careful).toBe(true);
    expect(reactive.careful).toBe(false);
    expect(deep.recovers).toBeGreaterThanOrEqual(balanced.recovers);
  });

  it("only verifies when the agent carries a tool that can verify", () => {
    const base = blankAgentConfig();
    expect(deriveProfile({ ...base, tools: ["file.read", "file.write"] }, "s").verifies).toBe(false);
    expect(deriveProfile({ ...base, tools: ["file.read", "shell.exec"] }, "s").verifies).toBe(true);
    expect(deriveProfile({ ...base, tools: ["code.run"] }, "s").verifies).toBe(true);
  });

  it("tightens exploration when the step budget is small", () => {
    const base = { ...blankAgentConfig(), planning: "deep" as const };
    expect(deriveProfile({ ...base, maxSteps: 30 }, "s").explore).toBe(2);
    expect(deriveProfile({ ...base, maxSteps: 8 }, "s").explore).toBe(1);
    expect(deriveProfile({ ...base, maxSteps: 8 }, "s").verifies).toBe(false);
  });

  it("is deterministic for the same seed and agent", () => {
    const config = blankAgentConfig();
    const a = deriveProfile(config, "seed-1");
    const b = deriveProfile(config, "seed-1");
    expect(a.rng()).toBe(b.rng());
  });

  it("differs across seeds", () => {
    const config = blankAgentConfig();
    expect(deriveProfile(config, "seed-1").rng()).not.toBe(deriveProfile(config, "seed-2").rng());
  });
});

describe("seededRng", () => {
  it("produces a stable sequence in [0, 1)", () => {
    const rng = seededRng("abc");
    const values = Array.from({ length: 200 }, () => rng());
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(seededRng("abc")().toFixed(12)).toBe(seededRng("abc")().toFixed(12));
  });
});

describe("rate limiting", () => {
  it("allows up to the limit and then refuses", () => {
    resetRateLimits();
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("k", 3, 60_000).allowed).toBe(true);
    }
    const blocked = rateLimit("k", 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetInMs).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    resetRateLimits();
    rateLimit("a", 1, 60_000);
    expect(rateLimit("a", 1, 60_000).allowed).toBe(false);
    expect(rateLimit("b", 1, 60_000).allowed).toBe(true);
  });

  it("opens a new window once the old one expires", async () => {
    resetRateLimits();
    expect(rateLimit("w", 1, 20).allowed).toBe(true);
    expect(rateLimit("w", 1, 20).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(rateLimit("w", 1, 20).allowed).toBe(true);
  });
});
