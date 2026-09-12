import "server-only";

import type {
  Agent,
  AgentRecord,
  Artifact,
  Evaluation,
  Execution,
  ExecutionEvent,
  LeaderboardEntry,
  Match,
  Rating,
  Replay,
  Score,
  Season,
  Task,
  ToolCall,
} from "@/lib/arena/types";
import { getStore } from "@/lib/store";
import { getTask } from "@/lib/tasks";
import { ratingSystem } from "@/lib/rating/elo";
import { explainWin, type WinFactor } from "@/lib/eval/scoring";

/**
 * Read-side aggregations.
 *
 * Server components call these directly rather than fetching their own API —
 * one less hop, and the API routes below use the same functions, so a page and
 * its JSON endpoint can never disagree.
 */

export interface AgentSideDetail {
  side: "A" | "B";
  agent: Agent | null;
  configSnapshot: Match["participants"][number]["configSnapshot"];
  execution: Execution | null;
  score: Score | null;
  evaluation: Evaluation | null;
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  ratingBefore: number;
  ratingAfter: number | null;
}

export interface MatchDetail {
  match: Match;
  task: Task | null;
  season: Season | null;
  sides: [AgentSideDetail, AgentSideDetail];
  winner: AgentSideDetail | null;
  loser: AgentSideDetail | null;
  /** Derived entirely by subtracting stored measurements. */
  whyWon: WinFactor[];
  events: ExecutionEvent[];
}

export async function getMatchDetail(matchId: string): Promise<MatchDetail | null> {
  const store = await getStore();
  const match = await store.getMatch(matchId);
  if (!match) return null;

  const [season, events] = await Promise.all([
    store.getSeason(match.seasonId),
    store.getEvents(match.id),
  ]);

  const sides = (await Promise.all(
    match.participants.map(async (participant): Promise<AgentSideDetail> => {
      const agent = await store.getAgent(participant.agentId);
      const executionId = participant.executionId;
      const [execution, score, evaluation, toolCalls, artifacts] = executionId
        ? await Promise.all([
            store.getExecution(executionId),
            store.getScore(executionId),
            store.getEvaluation(executionId),
            store.getToolCalls(executionId),
            store.getArtifacts(executionId),
          ])
        : [null, null, null, [], []];

      return {
        side: participant.side,
        agent,
        configSnapshot: participant.configSnapshot,
        execution,
        score,
        evaluation,
        toolCalls,
        artifacts,
        ratingBefore: participant.ratingBefore,
        ratingAfter: participant.ratingAfter,
      };
    }),
  )) as [AgentSideDetail, AgentSideDetail];

  const winner =
    match.result === "A" ? sides[0] : match.result === "B" ? sides[1] : null;
  const loser = match.result === "A" ? sides[1] : match.result === "B" ? sides[0] : null;

  const whyWon =
    winner?.score && winner.evaluation && loser?.score && loser.evaluation
      ? explainWin(
          { score: winner.score, metrics: winner.evaluation.metrics },
          { score: loser.score, metrics: loser.evaluation.metrics },
        )
      : [];

  return {
    match,
    task: getTask(match.taskId) ?? null,
    season,
    sides,
    winner,
    loser,
    whyWon,
    events,
  };
}

export async function getReplay(matchId: string): Promise<Replay | null> {
  const store = await getStore();
  const match = await store.getMatch(matchId);
  if (!match) return null;
  const events = await store.getEvents(matchId);
  if (events.length === 0) return null;

  const durationMs = events[events.length - 1]?.t ?? 0;
  const markers = events
    .filter((e) =>
      [
        "agent.tool_failed",
        "agent.recovery_completed",
        "agent.artifact_created",
        "agent.task_completed",
        "agent.task_failed",
        "agent.limit_reached",
        "match.completed",
      ].includes(e.type),
    )
    .map((e) => ({ t: e.t, side: e.side, type: e.type, label: e.label }));

  return { matchId, durationMs, events, markers };
}

// ─── records & leaderboard ──────────────────────────────────────────────────

export async function getAgentRecord(agentId: string, seasonId?: string): Promise<AgentRecord> {
  const store = await getStore();
  const season = seasonId ?? (await store.activeSeason()).id;
  const matches = (await store.listMatches({ agentId, seasonId: season })).filter(
    (m) => m.status === "complete",
  );

  const empty: AgentRecord = {
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winRate: null,
    avgScore: null,
    successRate: null,
    recoveryRate: null,
    avgCostUsd: null,
    avgDurationMs: null,
    demoShare: null,
  };
  if (matches.length === 0) return empty;

  let wins = 0;
  let losses = 0;
  let draws = 0;
  let demo = 0;
  const scores: number[] = [];
  const costs: number[] = [];
  const durations: number[] = [];
  let recoveries = 0;
  let failures = 0;
  let succeeded = 0;

  for (const match of matches) {
    const participant = match.participants.find((p) => p.agentId === agentId);
    if (!participant) continue;
    if (match.mode === "demo") demo += 1;

    if (match.result === "draw") draws += 1;
    else if (match.result === participant.side) wins += 1;
    else losses += 1;

    if (participant.scoreTotal !== null) scores.push(participant.scoreTotal);

    if (participant.executionId) {
      const [execution, evaluation] = await Promise.all([
        store.getExecution(participant.executionId),
        store.getEvaluation(participant.executionId),
      ]);
      if (execution) {
        if (execution.usage.costUsd !== null) costs.push(execution.usage.costUsd);
        if (execution.durationMs !== null) durations.push(execution.durationMs);
        if (execution.outcome === "completed") succeeded += 1;
      }
      const f = numberMetric(evaluation, "recovery.failures");
      const r = numberMetric(evaluation, "recovery.recovered");
      if (f !== null) failures += f;
      if (r !== null) recoveries += r;
    }
  }

  return {
    matches: matches.length,
    wins,
    losses,
    draws,
    winRate: matches.length ? wins / matches.length : null,
    avgScore: mean(scores),
    successRate: matches.length ? succeeded / matches.length : null,
    recoveryRate: failures > 0 ? recoveries / failures : null,
    // Null, not zero: no provider reported a cost, so there is nothing to average.
    avgCostUsd: mean(costs),
    avgDurationMs: mean(durations),
    demoShare: matches.length ? demo / matches.length : null,
  };
}

export interface LeaderboardOptions {
  seasonId?: string;
  scope?: string;
  ownerId?: string;
  limit?: number;
}

export async function getLeaderboard(options: LeaderboardOptions = {}): Promise<{
  entries: LeaderboardEntry[];
  season: Season;
  scope: string;
  /** Share of rated matches in this scope that ran in demo mode. */
  demoShare: number | null;
}> {
  const store = await getStore();
  const season = options.seasonId ? await store.getSeason(options.seasonId) : await store.activeSeason();
  if (!season) throw new Error(`unknown season: ${options.seasonId}`);
  const scope = options.scope ?? "overall";

  const [ratings, agents, matches] = await Promise.all([
    store.listRatings(season.id, scope),
    store.listAgents(),
    store.listMatches({ seasonId: season.id, status: "complete" }),
  ]);

  const rated = new Map(ratings.map((r) => [r.agentId, r]));

  // Agents with no rated match in this scope still appear, unranked, so a newly
  // built agent is visible rather than invisible until its first win.
  const rows: { agent: Agent; rating: Rating }[] = [];
  for (const agent of agents) {
    if (options.ownerId && agent.ownerId !== options.ownerId) continue;
    const rating = rated.get(agent.id);
    rows.push({
      agent,
      rating:
        rating ??
        {
          agentId: agent.id,
          seasonId: season.id,
          scope,
          rating: ratingSystem().initialRating,
          games: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          peak: ratingSystem().initialRating,
          updatedAt: agent.updatedAt,
        },
    });
  }

  rows.sort((a, b) => {
    if (a.rating.games === 0 && b.rating.games > 0) return 1;
    if (b.rating.games === 0 && a.rating.games > 0) return -1;
    return b.rating.rating - a.rating.rating || b.rating.wins - a.rating.wins;
  });

  const limited = options.limit ? rows.slice(0, options.limit) : rows;
  const entries: LeaderboardEntry[] = await Promise.all(
    limited.map(async (row, index) => ({
      rank: row.rating.games === 0 ? 0 : index + 1,
      agent: row.agent,
      rating: row.rating,
      record: await getAgentRecord(row.agent.id, season.id),
    })),
  );

  const relevant = matches.filter((m) => scope === "overall" || getTask(m.taskId)?.category === scope);
  const demoShare = relevant.length
    ? relevant.filter((m) => m.mode === "demo").length / relevant.length
    : null;

  return { entries, season, scope, demoShare };
}

export async function getAgentProfile(idOrHandle: string): Promise<{
  agent: Agent;
  record: AgentRecord;
  ratings: Rating[];
  recentMatches: Match[];
} | null> {
  const store = await getStore();
  const agent = (await store.getAgent(idOrHandle)) ?? (await store.getAgentByHandle(idOrHandle));
  if (!agent) return null;

  const season = await store.activeSeason();
  const [record, matches] = await Promise.all([
    getAgentRecord(agent.id, season.id),
    store.listMatches({ agentId: agent.id, limit: 12 }),
  ]);

  const scopes = ["overall", "coding", "debugging", "research", "data", "ui", "reasoning", "automation"];
  const ratings = (
    await Promise.all(scopes.map((scope) => store.getRating(agent.id, season.id, scope)))
  ).filter((r): r is Rating => r !== null && r.games > 0);

  return { agent, record, ratings, recentMatches: matches };
}

// ─── arena-wide telemetry (landing page) ────────────────────────────────────

export interface ArenaStats {
  agents: number;
  matches: number;
  matchesToday: number;
  tasksCompleted: number;
  successRate: number | null;
  liveMatches: number;
  demoShare: number | null;
}

export async function getArenaStats(): Promise<ArenaStats> {
  const store = await getStore();
  const [agents, matches] = await Promise.all([store.listAgents(), store.listMatches()]);
  const complete = matches.filter((m) => m.status === "complete");
  const dayAgo = Date.now() - 86_400_000;

  let executionsCompleted = 0;
  let executionsTotal = 0;
  for (const match of complete) {
    for (const participant of match.participants) {
      if (!participant.executionId) continue;
      executionsTotal += 1;
      const execution = await store.getExecution(participant.executionId);
      if (execution?.outcome === "completed") executionsCompleted += 1;
    }
  }

  return {
    agents: agents.length,
    matches: matches.length,
    matchesToday: matches.filter((m) => m.createdAt >= dayAgo).length,
    tasksCompleted: executionsCompleted,
    successRate: executionsTotal ? executionsCompleted / executionsTotal : null,
    liveMatches: matches.filter((m) => m.status === "running" || m.status === "evaluating").length,
    demoShare: complete.length ? complete.filter((m) => m.mode === "demo").length / complete.length : null,
  };
}

export async function listRecentMatches(limit = 8): Promise<
  { match: Match; task: Task | null; agents: (Agent | null)[] }[]
> {
  const store = await getStore();
  const matches = await store.listMatches({ limit });
  return Promise.all(
    matches.map(async (match) => ({
      match,
      task: getTask(match.taskId) ?? null,
      agents: await Promise.all(match.participants.map((p) => store.getAgent(p.agentId))),
    })),
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function numberMetric(evaluation: Evaluation | null, key: string): number | null {
  return evaluation?.metrics.find((m) => m.key === key)?.value ?? null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
