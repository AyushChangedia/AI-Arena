/**
 * Scripted policies.
 *
 * A policy stands in for a model's decision-making in a DEMO match. It is the
 * ONLY thing that differs between a demo match and a live one: the harness,
 * tools, filesystem, code execution, graders, scoring and rating are identical
 * and real in both.
 *
 * Two properties matter:
 *
 * 1. **Policies react to real results.** `next()` receives the actual tool
 *    outputs, including real errors. A policy that recovers is recovering from
 *    a failure that genuinely happened.
 * 2. **Policies do not decide outcomes.** A policy writes code; the graders
 *    decide whether it passes. Authoring a sloppy implementation produces a
 *    real failing test, not a hardcoded loss.
 *
 * The profile is derived from the agent's own configuration, so an agent built
 * in the builder behaves according to how it was configured — a deep planner
 * really does explore more before acting.
 */

import type { AgentConfig } from "@/lib/arena/types";
import { fnv1a64 } from "@/lib/sandbox/vfs";

export interface PolicyObservation {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  error: string | null;
}

export interface PolicyProfile {
  /** Exploration steps before the first write. From `planning`. */
  explore: number;
  /** Writes the careful implementation rather than the quick one. */
  careful: boolean;
  /** Verifies its work before declaring completion. */
  verifies: boolean;
  /** Attempts a fix after a failed verification instead of giving up. */
  recovers: number;
  /** Deterministic per (seed, agent). Drives small authored variations. */
  rng: () => number;
}

export interface PolicyContext {
  step: number;
  history: PolicyObservation[];
  profile: PolicyProfile;
  /** Tools this execution may actually use. A policy must not exceed it. */
  catalogue: Set<string>;
}

export type PolicyAction =
  | { kind: "tool"; think: string; tool: string; args: Record<string, unknown> }
  | { kind: "finish"; think: string; message: string };

export interface ScriptedPolicy {
  readonly id: string;
  /** Shown on the match page so the scripted behaviour is inspectable. */
  readonly describe: string;
  next(ctx: PolicyContext): PolicyAction;
}

/**
 * Derives a behavioural profile from the agent's real configuration. Documented
 * here because it is the mechanism by which a user-built agent behaves
 * differently in demo mode — nothing about it is random or hidden.
 *
 *   planning: deep      → explores 2 extra steps, careful, recovers twice
 *   planning: balanced  → explores 1 extra step, careful, recovers once
 *   planning: reactive  → no exploration, quick implementation, recovers once
 *   verification        → requires a tool that can actually verify (shell/code)
 *   maxSteps < 12       → too tight a budget to both explore and verify
 */
export function deriveProfile(config: AgentConfig, seed: string): PolicyProfile {
  const rng = seededRng(`${seed}:${config.handle}`);
  const canVerify = config.tools.includes("shell.exec") || config.tools.includes("code.run");

  const base =
    config.planning === "deep"
      ? { explore: 2, careful: true, recovers: 2 }
      : config.planning === "balanced"
        ? { explore: 1, careful: true, recovers: 1 }
        : { explore: 0, careful: false, recovers: 1 };

  const tight = config.maxSteps < 12;

  return {
    explore: tight ? Math.min(base.explore, 1) : base.explore,
    careful: base.careful,
    verifies: canVerify && !tight,
    recovers: base.recovers,
    rng,
  };
}

/** Small, fast, deterministic PRNG (mulberry32) seeded from a string. */
export function seededRng(seed: string): () => number {
  let a = parseInt(fnv1a64(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience for policies: the last observation for a given tool. */
export function lastFor(history: PolicyObservation[], tool: string): PolicyObservation | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.tool === tool) return history[i];
  }
  return undefined;
}

export function countOf(history: PolicyObservation[], tool: string): number {
  return history.filter((h) => h.tool === tool).length;
}

/** True once the most recent verification attempt succeeded. */
export function verificationPassed(history: PolicyObservation[], marker: RegExp): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.tool === "shell.exec" || h.tool === "code.run") {
      return h.ok && marker.test(h.output);
    }
  }
  return false;
}
