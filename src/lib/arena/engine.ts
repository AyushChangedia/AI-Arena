import "server-only";

import type {
  Agent,
  AgentConfig,
  ExecutionEvent,
  ExecutionMode,
  Match,
  MatchParticipant,
  Metric,
  Rating,
  Score,
  Side,
  Task,
} from "./types";
import type { ModelProvider } from "@/lib/agents/providers/types";
import { liveProviders } from "@/lib/agents/providers/registry";
import { ScriptedProvider } from "@/lib/agents/providers/scripted";
import { deriveProfile } from "@/lib/agents/policies/types";
import { Vfs, DEFAULT_VFS_LIMITS } from "@/lib/sandbox/vfs";
import { VirtualShell } from "@/lib/sandbox/shell";
import { codeExecutor } from "@/lib/sandbox/vm";
import { createSearchBackend } from "@/lib/tools/web";
import { getTaskDefinition } from "@/lib/tasks";
import { runAgent } from "./harness";
import { eventBus, topicFor } from "./events";
import { id } from "./ids";
import { computeScore, decideMatch, type Decision } from "@/lib/eval/scoring";
import { evaluateExecution } from "@/lib/eval/hybrid";
import { ratingSystem } from "@/lib/rating/elo";
import { getStore } from "@/lib/store";
import type { ArenaStore } from "@/lib/store/types";

export class MatchError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_state" | "invalid_task" | "invalid_agent",
  ) {
    super(message);
    this.name = "MatchError";
  }
}

// ─── creation ───────────────────────────────────────────────────────────────

export interface CreateMatchInput {
  taskId: string;
  agentAId: string;
  agentBId: string;
  seed?: string;
  rated?: boolean;
}

export async function createMatch(input: CreateMatchInput): Promise<Match> {
  const store = await getStore();
  const def = getTaskDefinition(input.taskId);
  if (!def) throw new MatchError(`unknown task: ${input.taskId}`, "invalid_task");

  const [agentA, agentB] = await Promise.all([
    store.getAgent(input.agentAId),
    store.getAgent(input.agentBId),
  ]);
  if (!agentA) throw new MatchError(`unknown agent: ${input.agentAId}`, "invalid_agent");
  if (!agentB) throw new MatchError(`unknown agent: ${input.agentBId}`, "invalid_agent");
  if (agentA.id === agentB.id) {
    throw new MatchError("an agent cannot face itself", "invalid_agent");
  }

  const season = await store.activeSeason();
  const seed = input.seed ?? `${input.taskId}:${Date.now().toString(36)}`;
  const number = await store.nextMatchNumber();

  const modeA = resolveMode(agentA.config);
  const modeB = resolveMode(agentB.config);

  const match: Match = {
    id: id("match"),
    number,
    taskId: def.task.id,
    seasonId: season.id,
    // A match is only LIVE when both sides actually ran a model.
    mode: modeA === "live" && modeB === "live" ? "live" : "demo",
    status: "pending",
    result: null,
    participants: [
      await participantFor(store, agentA, "A", season.id),
      await participantFor(store, agentB, "B", season.id),
    ],
    seed,
    envHash: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    rated: input.rated ?? true,
    error: null,
  };

  return store.createMatch(match);
}

async function participantFor(
  store: ArenaStore,
  agent: Agent,
  side: Side,
  seasonId: string,
): Promise<MatchParticipant> {
  const rating = await store.getRating(agent.id, seasonId, "overall");
  return {
    side,
    agentId: agent.id,
    configHash: agent.configHash,
    configSnapshot: agent.config,
    executionId: null,
    scoreTotal: null,
    ratingBefore: rating?.rating ?? ratingSystem().initialRating,
    ratingAfter: null,
  };
}

/** Live when the agent's declared provider has a key; otherwise demo. */
export function resolveMode(config: AgentConfig): ExecutionMode {
  if (config.model.provider === "scripted") return "demo";
  return liveProviders().get(config.model.provider)?.configured ? "live" : "demo";
}

// ─── execution ──────────────────────────────────────────────────────────────

const running = new Map<string, Promise<Match>>();

/**
 * Runs a match to completion. Idempotent per match id: a second call while one
 * is in flight joins the first rather than starting a parallel run.
 */
export async function startMatch(matchId: string): Promise<Match> {
  const existing = running.get(matchId);
  if (existing) return existing;

  const promise = execute(matchId).finally(() => running.delete(matchId));
  running.set(matchId, promise);
  return promise;
}

export function isRunning(matchId: string): boolean {
  return running.has(matchId);
}

async function execute(matchId: string): Promise<Match> {
  const store = await getStore();
  const bus = eventBus();
  const topic = topicFor(matchId);

  let match = await store.getMatch(matchId);
  if (!match) throw new MatchError(`unknown match: ${matchId}`, "not_found");
  if (match.status !== "pending") {
    throw new MatchError(`match ${match.number} has already run`, "invalid_state");
  }

  const def = getTaskDefinition(match.taskId);
  if (!def) throw new MatchError(`unknown task: ${match.taskId}`, "invalid_task");
  const task = def.task;

  const startedAt = Date.now();
  let seq = 0;
  const nextSeq = () => seq++;
  const allEvents: ExecutionEvent[] = [];

  // Events are mirrored into the store as the match runs, not only at the end.
  // The in-process bus only reaches subscribers on this instance, so without
  // this a browser following the match from another instance would watch a
  // blank arena until the whole thing finished. Batched behind a short debounce
  // because a write per event would be one round trip per tool call.
  let pendingPersist: ExecutionEvent[] = [];
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persisting: Promise<void> = Promise.resolve();

  const drainPersist = () => {
    if (pendingPersist.length === 0) return;
    const batch = pendingPersist;
    pendingPersist = [];
    persisting = persisting
      .then(() => store.saveEvents(matchId, batch))
      // A mirror failure must never take down the match it is mirroring; the
      // authoritative write still happens when the run ends.
      .catch((error) => console.error(`[arena] event mirror failed for ${matchId}:`, error));
  };

  const emit = (event: ExecutionEvent) => {
    allEvents.push(event);
    bus.publish(topic, event);

    pendingPersist.push(event);
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        drainPersist();
      }, 250);
      persistTimer.unref?.();
    }
  };

  /** Stop mirroring and let any in-flight write settle before the final save. */
  const settlePersist = async () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    drainPersist();
    await persisting;
  };

  const emitMatchEvent = (
    type: ExecutionEvent["type"],
    label: string,
    extra: Partial<ExecutionEvent> = {},
  ) => {
    const now = Date.now();
    emit({
      id: id("evt"),
      seq: nextSeq(),
      matchId,
      executionId: null,
      agentId: null,
      side: null,
      type,
      at: now,
      t: now - startedAt,
      step: 0,
      label,
      ...extra,
    });
  };

  // ── fairness: one spec, two identical materialisations ────────────────────
  const spec = def.environment(match.seed);
  const vfsA = Vfs.fromSnapshot(spec, DEFAULT_VFS_LIMITS);
  const vfsB = Vfs.fromSnapshot(spec, DEFAULT_VFS_LIMITS);
  const hashA = vfsA.hash();
  const hashB = vfsB.hash();
  if (hashA !== hashB) {
    // Non-deterministic task environment: refuse rather than run an unfair match.
    match = {
      ...match,
      status: "failed",
      error: `environment is not deterministic for seed "${match.seed}" (${hashA} vs ${hashB})`,
      endedAt: Date.now(),
    };
    await store.updateMatch(match);
    throw new MatchError(match.error!, "invalid_task");
  }

  match = { ...match, status: "running", startedAt, envHash: hashA };
  await store.updateMatch(match);

  emitMatchEvent("match.started", `Match #${match.number} — ${task.title}`, {
    data: {
      task: task.slug,
      mode: match.mode,
      envHash: hashA,
      seed: match.seed,
      agents: match.participants.map((p) => p.configSnapshot.name),
    },
  });

  const controller = new AbortController();
  const matchDeadline = setTimeout(
    () => controller.abort(),
    task.limits.timeLimitMs + 30_000,
  );
  matchDeadline.unref?.();

  const executor = codeExecutor();
  const search = createSearchBackend();

  const sides = match.participants.map((participant, index) => {
    const vfs = index === 0 ? vfsA : vfsB;
    const shell = new VirtualShell({
      vfs,
      executor,
      hooks: def.shellHooks(executor),
      timeoutMs: 10_000,
    });
    const executionId = id("exec");
    const mode = resolveMode(participant.configSnapshot);
    const provider = providerFor(participant.configSnapshot, task, match!.seed, mode);
    return { participant, vfs, shell, executionId, mode, provider };
  });

  try {
    const results = await Promise.all(
      sides.map((s) =>
        runAgent({
          matchId,
          executionId: s.executionId,
          side: s.participant.side,
          agentId: s.participant.agentId,
          config: s.participant.configSnapshot,
          task,
          mode: s.mode,
          provider: s.provider,
          vfs: s.vfs,
          shell: s.shell,
          executor,
          search,
          matchStartedAt: startedAt,
          nextSeq,
          emit,
          signal: controller.signal,
        }),
      ),
    );

    match = { ...match, status: "evaluating" };
    await store.updateMatch(match);
    emitMatchEvent("eval.started", "Evaluating both executions");

    // ── evaluate, score ────────────────────────────────────────────────────
    type Graded = {
      side: (typeof sides)[number];
      result: (typeof results)[number];
      evaluation: Awaited<ReturnType<typeof evaluateExecution>>["evaluation"];
      score: Score;
    };
    const graded: Graded[] = [];
    for (const [index, result] of results.entries()) {
      const s = sides[index]!;
      const { evaluation, unavailable } = await evaluateExecution(
        {
          task,
          vfs: s.vfs,
          executor,
          events: result.events,
          toolCalls: result.toolCalls,
          artifacts: result.artifacts,
          steps: result.steps,
          stepLimit: Math.min(s.participant.configSnapshot.maxSteps, task.limits.stepLimit),
          durationMs: result.durationMs,
          outcome: result.outcome,
          usage: result.usage,
        },
        s.executionId,
      );

      const score = computeScore({
        executionId: s.executionId,
        task,
        metrics: evaluation.metrics,
        unavailable,
      });

      emitMatchEvent("eval.dimension", `${s.participant.configSnapshot.name} scored ${score.total.toFixed(1)}`, {
        side: s.participant.side,
        agentId: s.participant.agentId,
        executionId: s.executionId,
        data: {
          total: score.total,
          testsPassRate: metricValue(evaluation.metrics, "tests.passRate"),
        },
      });

      graded.push({ side: s, result, evaluation, score });

      await store.saveExecution({
        id: s.executionId,
        matchId,
        agentId: s.participant.agentId,
        side: s.participant.side,
        mode: s.mode,
        provider: s.participant.configSnapshot.model.provider,
        model: s.participant.configSnapshot.model.model,
        startedAt,
        endedAt: Date.now(),
        durationMs: result.durationMs,
        steps: result.steps,
        outcome: result.outcome,
        state: result.state,
        usage: result.usage,
        finalMessage: result.finalMessage,
        error: result.error,
      });
      await store.saveToolCalls(s.executionId, result.toolCalls);
      await store.saveArtifacts(s.executionId, result.artifacts);
      await store.saveEvaluation(evaluation);
      await store.saveScore(score);
    }

    const [a, b] = graded as [Graded, Graded];
    const decision = decideMatch(
      {
        score: a.score.total,
        testsPassRate: metricValue(a.evaluation.metrics, "tests.passRate"),
        outcome: a.result.outcome,
      },
      {
        score: b.score.total,
        testsPassRate: metricValue(b.evaluation.metrics, "tests.passRate"),
        outcome: b.result.outcome,
      },
    );

    // ── ratings ────────────────────────────────────────────────────────────
    const ratingDeltas = match.rated
      ? await applyRatings(store, match, task, decision, [a.score, b.score])
      : [null, null];

    const participants = match.participants.map((p, index) => ({
      ...p,
      executionId: graded[index]!.side.executionId,
      scoreTotal: graded[index]!.score.total,
      ratingAfter: ratingDeltas[index],
    })) as [MatchParticipant, MatchParticipant];

    emitMatchEvent("eval.completed", "Evaluation complete");
    emitMatchEvent("match.completed", labelForDecision(decision, participants), {
      data: {
        result: decision,
        scores: participants.map((p) => p.scoreTotal),
      },
    });

    match = {
      ...match,
      status: "complete",
      result: decision,
      participants,
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
    await store.updateMatch(match);
    await settlePersist();
    await store.saveEvents(matchId, allEvents);
    await store.flush();
    return match;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emitMatchEvent("match.completed", "Match failed", { status: "error", detail: message });
    match = {
      ...match,
      status: "failed",
      error: message,
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
    await store.updateMatch(match);
    await settlePersist();
    await store.saveEvents(matchId, allEvents);
    await store.flush();
    return match;
  } finally {
    clearTimeout(matchDeadline);
    bus.close(topic);
  }
}

function providerFor(
  config: AgentConfig,
  task: Task,
  seed: string,
  mode: ExecutionMode,
): ModelProvider {
  if (mode === "live") {
    const provider = liveProviders().get(config.model.provider);
    if (provider) return provider;
  }
  const def = getTaskDefinition(task.id)!;
  const profile = deriveProfile(config, seed);
  const catalogue = new Set(config.tools.filter((t) => task.toolsAllowed.includes(t)));
  return new ScriptedProvider(def.policy(profile), catalogue, profile);
}

// ─── ranking ────────────────────────────────────────────────────────────────

async function applyRatings(
  store: ArenaStore,
  match: Match,
  task: Task,
  decision: Decision,
  scores: [Score, Score],
): Promise<[number, number]> {
  const system = ratingSystem();
  const outcomeA =
    decision === "A" ? "win" : decision === "B" ? "loss" : decision === "draw" ? "draw" : "loss";
  const outcomeB =
    decision === "B" ? "win" : decision === "A" ? "loss" : decision === "draw" ? "draw" : "loss";

  let overallA = 0;
  let overallB = 0;

  for (const scope of ["overall", task.category]) {
    const [pa, pb] = match.participants;
    const current = await Promise.all([
      store.getRating(pa.agentId, match.seasonId, scope),
      store.getRating(pb.agentId, match.seasonId, scope),
    ]);
    const ratingA = current[0]?.rating ?? system.initialRating;
    const ratingB = current[1]?.rating ?? system.initialRating;

    // A double failure moves both toward the loser side: two agents failing
    // badly does not crown one of them.
    const update =
      decision === "double_failure"
        ? {
            a: { before: ratingA, after: Math.round(ratingA - 8), delta: -8 },
            b: { before: ratingB, after: Math.round(ratingB - 8), delta: -8 },
          }
        : system.update(ratingA, ratingB, outcomeA);

    await store.saveRating(nextRating(current[0], pa.agentId, match.seasonId, scope, update.a.after, outcomeA, decision));
    await store.saveRating(nextRating(current[1], pb.agentId, match.seasonId, scope, update.b.after, outcomeB, decision));

    if (scope === "overall") {
      overallA = update.a.after;
      overallB = update.b.after;
    }
  }

  void scores;
  return [overallA, overallB];
}

function nextRating(
  previous: Rating | null,
  agentId: string,
  seasonId: string,
  scope: string,
  rating: number,
  outcome: "win" | "loss" | "draw",
  decision: Decision,
): Rating {
  const base: Rating = previous ?? {
    agentId,
    seasonId,
    scope,
    rating: ratingSystem().initialRating,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    peak: ratingSystem().initialRating,
    updatedAt: Date.now(),
  };
  const counted = decision === "double_failure" ? "loss" : outcome;
  return {
    ...base,
    rating,
    games: base.games + 1,
    wins: base.wins + (counted === "win" ? 1 : 0),
    losses: base.losses + (counted === "loss" ? 1 : 0),
    draws: base.draws + (counted === "draw" ? 1 : 0),
    peak: Math.max(base.peak, rating),
    updatedAt: Date.now(),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function metricValue(metrics: Metric[], key: string): number | null {
  return metrics.find((m) => m.key === key)?.value ?? null;
}

function labelForDecision(decision: Decision, participants: MatchParticipant[]): string {
  switch (decision) {
    case "A":
      return `${participants[0]?.configSnapshot.name} wins`;
    case "B":
      return `${participants[1]?.configSnapshot.name} wins`;
    case "draw":
      return "Draw";
    default:
      return "Double failure — no winner";
  }
}
