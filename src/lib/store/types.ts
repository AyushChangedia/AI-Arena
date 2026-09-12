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
 * The full persistence surface.
 *
 * Every method is one logical query and no caller reaches around it, which is
 * what makes a Postgres/Drizzle driver a drop-in replacement for the shipped
 * file driver.
 */
export interface ArenaStore {
  // agents
  listAgents(filter?: { ownerId?: string; visibility?: "public" | "private" }): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | null>;
  getAgentByHandle(handle: string): Promise<Agent | null>;
  createAgent(agent: Agent): Promise<Agent>;
  updateAgent(agent: Agent): Promise<Agent>;
  deleteAgent(id: string): Promise<boolean>;
  listAgentVersions(agentId: string): Promise<AgentVersion[]>;
  createAgentVersion(version: AgentVersion): Promise<AgentVersion>;

  // matches
  createMatch(match: Match): Promise<Match>;
  updateMatch(match: Match): Promise<Match>;
  getMatch(id: string): Promise<Match | null>;
  listMatches(filter?: {
    agentId?: string;
    taskId?: string;
    seasonId?: string;
    status?: MatchStatus;
    limit?: number;
  }): Promise<Match[]>;
  nextMatchNumber(): Promise<number>;

  // executions and their children
  saveExecution(execution: Execution): Promise<Execution>;
  getExecution(id: string): Promise<Execution | null>;
  listExecutions(matchId: string): Promise<Execution[]>;
  saveEvents(matchId: string, events: ExecutionEvent[]): Promise<void>;
  getEvents(matchId: string): Promise<ExecutionEvent[]>;
  saveToolCalls(executionId: string, calls: ToolCall[]): Promise<void>;
  getToolCalls(executionId: string): Promise<ToolCall[]>;
  saveArtifacts(executionId: string, artifacts: Artifact[]): Promise<void>;
  getArtifacts(executionId: string): Promise<Artifact[]>;
  saveEvaluation(evaluation: Evaluation): Promise<void>;
  getEvaluation(executionId: string): Promise<Evaluation | null>;
  saveScore(score: Score): Promise<void>;
  getScore(executionId: string): Promise<Score | null>;

  // ranking
  getRating(agentId: string, seasonId: string, scope: string): Promise<Rating | null>;
  saveRating(rating: Rating): Promise<void>;
  listRatings(seasonId: string, scope: string): Promise<Rating[]>;

  // seasons
  listSeasons(): Promise<Season[]>;
  getSeason(id: string): Promise<Season | null>;
  activeSeason(): Promise<Season>;
  saveSeason(season: Season): Promise<void>;

  /** Flush any pending writes. Called before the process expects to be read. */
  flush(): Promise<void>;
}
