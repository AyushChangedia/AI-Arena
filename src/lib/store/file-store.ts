import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ArenaStore } from "./types";
import type {
  Agent,
  AgentVersion,
  Artifact,
  Evaluation,
  Execution,
  ExecutionEvent,
  Match,
  MatchStatus,
  Rating,
  Score,
  Season,
  ToolCall,
} from "@/lib/arena/types";

/**
 * File-backed store.
 *
 * An in-memory index with debounced, atomic snapshots to disk
 * (write-temp-then-rename, so a crash mid-write cannot corrupt the file).
 *
 * The choice is deliberate: a product whose first run must work with zero setup
 * cannot require a container, a migration and a connection string. It degrades
 * to memory-only on a read-only filesystem rather than crashing, and says so
 * once instead of on every write.
 */

interface Snapshot {
  version: 1;
  agents: Agent[];
  agentVersions: AgentVersion[];
  matches: Match[];
  executions: Execution[];
  events: [string, ExecutionEvent[]][];
  toolCalls: [string, ToolCall[]][];
  artifacts: [string, Artifact[]][];
  evaluations: Evaluation[];
  scores: Score[];
  ratings: Rating[];
  seasons: Season[];
}

const FLUSH_DELAY_MS = 250;
/** Events dominate the file; older matches keep metadata but shed their trace. */
const MAX_PERSISTED_TRACES = 60;

export class FileStore implements ArenaStore {
  private agents = new Map<string, Agent>();
  private agentVersions = new Map<string, AgentVersion[]>();
  private matches = new Map<string, Match>();
  private executions = new Map<string, Execution>();
  private events = new Map<string, ExecutionEvent[]>();
  private toolCalls = new Map<string, ToolCall[]>();
  private artifacts = new Map<string, Artifact[]>();
  private evaluations = new Map<string, Evaluation>();
  private scores = new Map<string, Score>();
  private ratings = new Map<string, Rating>();
  private seasons = new Map<string, Season>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private persistent = true;
  private warned = false;
  private readonly file: string;

  constructor(dataDir = process.env.ARENA_DATA_DIR || ".data") {
    this.file = resolve(process.cwd(), dataDir, "arena.json");
    this.load();
  }

  // ── disk ──────────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const snapshot = JSON.parse(readFileSync(this.file, "utf8")) as Snapshot;
      if (snapshot.version !== 1) return;

      for (const a of snapshot.agents ?? []) this.agents.set(a.id, a);
      for (const v of snapshot.agentVersions ?? []) {
        const list = this.agentVersions.get(v.agentId) ?? [];
        list.push(v);
        this.agentVersions.set(v.agentId, list);
      }
      for (const m of snapshot.matches ?? []) this.matches.set(m.id, m);
      for (const e of snapshot.executions ?? []) this.executions.set(e.id, e);
      for (const [k, v] of snapshot.events ?? []) this.events.set(k, v);
      for (const [k, v] of snapshot.toolCalls ?? []) this.toolCalls.set(k, v);
      for (const [k, v] of snapshot.artifacts ?? []) this.artifacts.set(k, v);
      for (const e of snapshot.evaluations ?? []) this.evaluations.set(e.executionId, e);
      for (const s of snapshot.scores ?? []) this.scores.set(s.executionId, s);
      for (const r of snapshot.ratings ?? []) this.ratings.set(ratingKey(r.agentId, r.seasonId, r.scope), r);
      for (const s of snapshot.seasons ?? []) this.seasons.set(s.id, s);
    } catch (e) {
      // A corrupt or partial snapshot must not stop the app from starting.
      console.warn(`[arena] could not read ${this.file}; starting empty. ${(e as Error).message}`);
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (!this.persistent || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, FLUSH_DELAY_MS);
    // Never hold the process open for a debounce.
    this.timer.unref?.();
  }

  private writeNow(): void {
    if (!this.dirty || !this.persistent) return;
    const matchIds = [...this.matches.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_PERSISTED_TRACES)
      .map((m) => m.id);
    const keep = new Set(matchIds);

    const snapshot: Snapshot = {
      version: 1,
      agents: [...this.agents.values()],
      agentVersions: [...this.agentVersions.values()].flat(),
      matches: [...this.matches.values()],
      executions: [...this.executions.values()],
      events: [...this.events.entries()].filter(([k]) => keep.has(k)),
      toolCalls: [...this.toolCalls.entries()],
      artifacts: [...this.artifacts.entries()],
      evaluations: [...this.evaluations.values()],
      scores: [...this.scores.values()],
      ratings: [...this.ratings.values()],
      seasons: [...this.seasons.values()],
    };

    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = join(dirname(this.file), `.arena.${process.pid}.tmp`);
      writeFileSync(temp, JSON.stringify(snapshot), "utf8");
      renameSync(temp, this.file);
      this.dirty = false;
    } catch (e) {
      this.persistent = false;
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `[arena] ${this.file} is not writable — running in memory only for this process. ${(e as Error).message}`,
        );
      }
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeNow();
  }

  // ── agents ────────────────────────────────────────────────────────────────

  async listAgents(filter?: { ownerId?: string; visibility?: "public" | "private" }): Promise<Agent[]> {
    return [...this.agents.values()]
      .filter((a) => (filter?.ownerId ? a.ownerId === filter.ownerId : true))
      .filter((a) => (filter?.visibility ? a.visibility === filter.visibility : true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getAgent(id: string): Promise<Agent | null> {
    return this.agents.get(id) ?? null;
  }

  async getAgentByHandle(handle: string): Promise<Agent | null> {
    return [...this.agents.values()].find((a) => a.config.handle === handle) ?? null;
  }

  async createAgent(agent: Agent): Promise<Agent> {
    this.agents.set(agent.id, agent);
    this.schedule();
    return agent;
  }

  async updateAgent(agent: Agent): Promise<Agent> {
    this.agents.set(agent.id, agent);
    this.schedule();
    return agent;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const deleted = this.agents.delete(id);
    if (deleted) {
      this.agentVersions.delete(id);
      this.schedule();
    }
    return deleted;
  }

  async listAgentVersions(agentId: string): Promise<AgentVersion[]> {
    return [...(this.agentVersions.get(agentId) ?? [])].sort((a, b) => b.version - a.version);
  }

  async createAgentVersion(version: AgentVersion): Promise<AgentVersion> {
    const list = this.agentVersions.get(version.agentId) ?? [];
    list.push(version);
    this.agentVersions.set(version.agentId, list);
    this.schedule();
    return version;
  }

  // ── matches ───────────────────────────────────────────────────────────────

  async createMatch(match: Match): Promise<Match> {
    this.matches.set(match.id, match);
    this.schedule();
    return match;
  }

  async updateMatch(match: Match): Promise<Match> {
    this.matches.set(match.id, match);
    this.schedule();
    return match;
  }

  async getMatch(id: string): Promise<Match | null> {
    return this.matches.get(id) ?? null;
  }

  async listMatches(filter?: {
    agentId?: string;
    taskId?: string;
    seasonId?: string;
    status?: MatchStatus;
    limit?: number;
  }): Promise<Match[]> {
    let list = [...this.matches.values()];
    if (filter?.agentId) {
      list = list.filter((m) => m.participants.some((p) => p.agentId === filter.agentId));
    }
    if (filter?.taskId) list = list.filter((m) => m.taskId === filter.taskId);
    if (filter?.seasonId) list = list.filter((m) => m.seasonId === filter.seasonId);
    if (filter?.status) list = list.filter((m) => m.status === filter.status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return filter?.limit ? list.slice(0, filter.limit) : list;
  }

  async nextMatchNumber(): Promise<number> {
    let max = 1000;
    for (const m of this.matches.values()) max = Math.max(max, m.number);
    return max + 1;
  }

  // ── executions ────────────────────────────────────────────────────────────

  async saveExecution(execution: Execution): Promise<Execution> {
    this.executions.set(execution.id, execution);
    this.schedule();
    return execution;
  }

  async getExecution(id: string): Promise<Execution | null> {
    return this.executions.get(id) ?? null;
  }

  async listExecutions(matchId: string): Promise<Execution[]> {
    return [...this.executions.values()]
      .filter((e) => e.matchId === matchId)
      .sort((a, b) => a.side.localeCompare(b.side));
  }

  async saveEvents(matchId: string, events: ExecutionEvent[]): Promise<void> {
    this.events.set(matchId, events);
    this.schedule();
  }

  async getEvents(matchId: string): Promise<ExecutionEvent[]> {
    return [...(this.events.get(matchId) ?? [])];
  }

  async saveToolCalls(executionId: string, calls: ToolCall[]): Promise<void> {
    this.toolCalls.set(executionId, calls);
    this.schedule();
  }

  async getToolCalls(executionId: string): Promise<ToolCall[]> {
    return [...(this.toolCalls.get(executionId) ?? [])];
  }

  async saveArtifacts(executionId: string, artifacts: Artifact[]): Promise<void> {
    this.artifacts.set(executionId, artifacts);
    this.schedule();
  }

  async getArtifacts(executionId: string): Promise<Artifact[]> {
    return [...(this.artifacts.get(executionId) ?? [])];
  }

  async saveEvaluation(evaluation: Evaluation): Promise<void> {
    this.evaluations.set(evaluation.executionId, evaluation);
    this.schedule();
  }

  async getEvaluation(executionId: string): Promise<Evaluation | null> {
    return this.evaluations.get(executionId) ?? null;
  }

  async saveScore(score: Score): Promise<void> {
    this.scores.set(score.executionId, score);
    this.schedule();
  }

  async getScore(executionId: string): Promise<Score | null> {
    return this.scores.get(executionId) ?? null;
  }

  // ── ranking ───────────────────────────────────────────────────────────────

  async getRating(agentId: string, seasonId: string, scope: string): Promise<Rating | null> {
    return this.ratings.get(ratingKey(agentId, seasonId, scope)) ?? null;
  }

  async saveRating(rating: Rating): Promise<void> {
    this.ratings.set(ratingKey(rating.agentId, rating.seasonId, rating.scope), rating);
    this.schedule();
  }

  async listRatings(seasonId: string, scope: string): Promise<Rating[]> {
    return [...this.ratings.values()]
      .filter((r) => r.seasonId === seasonId && r.scope === scope)
      .sort((a, b) => b.rating - a.rating);
  }

  // ── seasons ───────────────────────────────────────────────────────────────

  async listSeasons(): Promise<Season[]> {
    return [...this.seasons.values()].sort((a, b) => b.number - a.number);
  }

  async getSeason(id: string): Promise<Season | null> {
    return this.seasons.get(id) ?? null;
  }

  async activeSeason(): Promise<Season> {
    const active = [...this.seasons.values()].find((s) => s.status === "active");
    if (active) return active;
    const newest = [...this.seasons.values()].sort((a, b) => b.number - a.number)[0];
    if (newest) return newest;
    throw new Error("no season exists — the store was not seeded");
  }

  async saveSeason(season: Season): Promise<void> {
    this.seasons.set(season.id, season);
    this.schedule();
  }

  /** True when snapshots are reaching disk. Surfaced on the system status page. */
  get isPersistent(): boolean {
    return this.persistent;
  }

  get location(): string {
    return this.file;
  }
}

function ratingKey(agentId: string, seasonId: string, scope: string): string {
  return `${seasonId}::${scope}::${agentId}`;
}
