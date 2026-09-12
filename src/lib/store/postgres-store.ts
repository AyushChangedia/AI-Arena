import "server-only";
import { Pool } from "pg";
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
 * Postgres-backed store.
 *
 * The file driver assumes one long-lived process. This one does not, which is
 * what makes the leaderboard, match history and permalinks survive a cold start
 * and stay consistent across however many instances are serving.
 *
 * ## Shape
 *
 * Every table keeps the entity whole in a `data jsonb` column, and lifts out
 * only the fields that are filtered, sorted or joined on into real indexed
 * columns. Reads always reconstruct from `data`, never from the columns — which
 * is deliberate: `pg` returns `bigint` as a string to avoid precision loss, so
 * reading a millisecond timestamp back out of a column would silently turn
 * `createdAt` into `"1770000000000"` and break every comparison downstream.
 * jsonb preserves the number.
 *
 * ## Ordering
 *
 * Match numbers come from a sequence rather than `max(number) + 1`, so two
 * matches created at the same moment on different instances cannot collide.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL,
  handle      text NOT NULL UNIQUE,
  visibility  text NOT NULL,
  origin      text,
  updated_at  bigint NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_id);
CREATE INDEX IF NOT EXISTS agents_updated_idx ON agents (updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_versions (
  id          text PRIMARY KEY,
  agent_id    text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_versions_agent_idx ON agent_versions (agent_id, version DESC);

CREATE TABLE IF NOT EXISTS matches (
  id          text PRIMARY KEY,
  number      integer NOT NULL,
  task_id     text NOT NULL,
  season_id   text NOT NULL,
  status      text NOT NULL,
  agent_ids   text[] NOT NULL,
  created_at  bigint NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_created_idx ON matches (created_at DESC);
CREATE INDEX IF NOT EXISTS matches_task_idx ON matches (task_id);
CREATE INDEX IF NOT EXISTS matches_season_idx ON matches (season_id);
CREATE INDEX IF NOT EXISTS matches_status_idx ON matches (status);
CREATE INDEX IF NOT EXISTS matches_agents_idx ON matches USING gin (agent_ids);

CREATE TABLE IF NOT EXISTS executions (
  id          text PRIMARY KEY,
  match_id    text NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_match_idx ON executions (match_id);

CREATE TABLE IF NOT EXISTS events (
  match_id    text NOT NULL,
  seq         integer NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  execution_id text NOT NULL,
  idx          integer NOT NULL,
  data         jsonb NOT NULL,
  PRIMARY KEY (execution_id, idx)
);

CREATE TABLE IF NOT EXISTS artifacts (
  execution_id text NOT NULL,
  idx          integer NOT NULL,
  data         jsonb NOT NULL,
  PRIMARY KEY (execution_id, idx)
);

CREATE TABLE IF NOT EXISTS evaluations (
  execution_id text PRIMARY KEY,
  data         jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  execution_id text PRIMARY KEY,
  data         jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  season_id   text NOT NULL,
  scope       text NOT NULL,
  agent_id    text NOT NULL,
  rating      double precision NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (season_id, scope, agent_id)
);
CREATE INDEX IF NOT EXISTS ratings_board_idx ON ratings (season_id, scope, rating DESC);

CREATE TABLE IF NOT EXISTS seasons (
  id          text PRIMARY KEY,
  number      integer NOT NULL,
  status      text NOT NULL,
  data        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  match_id    text NOT NULL,
  voter_id    text NOT NULL,
  side        text NOT NULL,
  created_at  bigint NOT NULL,
  PRIMARY KEY (match_id, voter_id)
);
CREATE INDEX IF NOT EXISTS votes_match_idx ON votes (match_id);

CREATE SEQUENCE IF NOT EXISTS match_number_seq START WITH 1001;
`;

/** The first match number, matching the file driver so the two agree. */
const FIRST_MATCH_NUMBER = 1001;

export class PostgresStore implements ArenaStore {
  private readonly pool: Pool;
  private ready: Promise<void> | null = null;
  private readonly label: string;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // Serverless multiplies instances, and every instance holds its own pool.
      // A small ceiling keeps a burst of cold starts from exhausting the
      // server's connection limit, which presents as a site-wide outage.
      max: Number(process.env.ARENA_PG_POOL_MAX ?? 4),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
    });
    // A pool error with no listener is an uncaught exception that takes the
    // process down; a dropped idle connection must not do that.
    this.pool.on("error", (error) => {
      console.error("[arena] postgres pool error:", error.message);
    });
    this.label = safeLabel(connectionString);
  }

  /** Applied once per process, and safe to run concurrently on many instances. */
  private migrate(): Promise<void> {
    this.ready ??= (async () => {
      await this.pool.query(SCHEMA);
      // Bring the sequence above anything already stored, so a database that
      // predates the sequence — or one restored from a dump — does not reissue
      // numbers that are already taken.
      await this.pool.query(
        `SELECT setval('match_number_seq',
                       GREATEST((SELECT COALESCE(MAX(number), $1) FROM matches), $1))`,
        [FIRST_MATCH_NUMBER - 1],
      );
    })();
    return this.ready;
  }

  private async query<T>(text: string, values: unknown[] = []): Promise<T[]> {
    await this.migrate();
    const result = await this.pool.query(text, values);
    return result.rows as T[];
  }

  /** Every read reconstructs the entity from jsonb, never from the columns. */
  private async rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
    const rows = await this.query<{ data: T }>(text, values);
    return rows.map((r) => r.data);
  }

  private async one<T>(text: string, values: unknown[] = []): Promise<T | null> {
    const [first] = await this.rows<T>(text, values);
    return first ?? null;
  }

  // ── agents ────────────────────────────────────────────────────────────────

  async listAgents(filter?: { ownerId?: string; visibility?: "public" | "private" }): Promise<Agent[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter?.ownerId) {
      values.push(filter.ownerId);
      where.push(`owner_id = $${values.length}`);
    }
    if (filter?.visibility) {
      values.push(filter.visibility);
      where.push(`visibility = $${values.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.rows<Agent>(`SELECT data FROM agents ${clause} ORDER BY updated_at DESC`, values);
  }

  async getAgent(id: string): Promise<Agent | null> {
    return this.one<Agent>("SELECT data FROM agents WHERE id = $1", [id]);
  }

  async getAgentByHandle(handle: string): Promise<Agent | null> {
    return this.one<Agent>("SELECT data FROM agents WHERE handle = $1", [handle]);
  }

  async createAgent(agent: Agent): Promise<Agent> {
    await this.query(
      `INSERT INTO agents (id, owner_id, handle, visibility, origin, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         owner_id = EXCLUDED.owner_id, handle = EXCLUDED.handle,
         visibility = EXCLUDED.visibility, origin = EXCLUDED.origin,
         updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [agent.id, agent.ownerId, agent.config.handle, agent.visibility, agent.origin ?? null, agent.updatedAt, agent],
    );
    return agent;
  }

  async updateAgent(agent: Agent): Promise<Agent> {
    return this.createAgent(agent);
  }

  async deleteAgent(id: string): Promise<boolean> {
    const rows = await this.query<{ id: string }>("DELETE FROM agents WHERE id = $1 RETURNING id", [id]);
    return rows.length > 0;
  }

  async listAgentVersions(agentId: string): Promise<AgentVersion[]> {
    return this.rows<AgentVersion>(
      "SELECT data FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC",
      [agentId],
    );
  }

  async createAgentVersion(version: AgentVersion): Promise<AgentVersion> {
    await this.query(
      `INSERT INTO agent_versions (id, agent_id, version, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [version.id, version.agentId, version.version, version],
    );
    return version;
  }

  // ── matches ───────────────────────────────────────────────────────────────

  async createMatch(match: Match): Promise<Match> {
    await this.query(
      `INSERT INTO matches (id, number, task_id, season_id, status, agent_ids, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         number = EXCLUDED.number, task_id = EXCLUDED.task_id, season_id = EXCLUDED.season_id,
         status = EXCLUDED.status, agent_ids = EXCLUDED.agent_ids,
         created_at = EXCLUDED.created_at, data = EXCLUDED.data`,
      [
        match.id,
        match.number,
        match.taskId,
        match.seasonId,
        match.status,
        match.participants.map((p) => p.agentId),
        match.createdAt,
        match,
      ],
    );
    return match;
  }

  async updateMatch(match: Match): Promise<Match> {
    return this.createMatch(match);
  }

  async getMatch(id: string): Promise<Match | null> {
    return this.one<Match>("SELECT data FROM matches WHERE id = $1", [id]);
  }

  async listMatches(filter?: {
    agentId?: string;
    taskId?: string;
    seasonId?: string;
    status?: MatchStatus;
    limit?: number;
  }): Promise<Match[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter?.agentId) {
      values.push(filter.agentId);
      where.push(`agent_ids @> ARRAY[$${values.length}]::text[]`);
    }
    for (const [column, value] of [
      ["task_id", filter?.taskId],
      ["season_id", filter?.seasonId],
      ["status", filter?.status],
    ] as const) {
      if (!value) continue;
      values.push(value);
      where.push(`${column} = $${values.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    let sql = `SELECT data FROM matches ${clause} ORDER BY created_at DESC`;
    if (filter?.limit) {
      values.push(filter.limit);
      sql += ` LIMIT $${values.length}`;
    }
    return this.rows<Match>(sql, values);
  }

  async nextMatchNumber(): Promise<number> {
    const [row] = await this.query<{ n: string }>("SELECT nextval('match_number_seq') AS n");
    return Number(row!.n);
  }

  // ── executions and their children ─────────────────────────────────────────

  async saveExecution(execution: Execution): Promise<Execution> {
    await this.query(
      `INSERT INTO executions (id, match_id, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET match_id = EXCLUDED.match_id, data = EXCLUDED.data`,
      [execution.id, execution.matchId, execution],
    );
    return execution;
  }

  async getExecution(id: string): Promise<Execution | null> {
    return this.one<Execution>("SELECT data FROM executions WHERE id = $1", [id]);
  }

  async listExecutions(matchId: string): Promise<Execution[]> {
    return this.rows<Execution>("SELECT data FROM executions WHERE match_id = $1", [matchId]);
  }

  async saveEvents(matchId: string, events: ExecutionEvent[]): Promise<void> {
    if (events.length === 0) return;
    // Upsert by (match_id, seq) rather than delete-then-insert: the streaming
    // path appends as the match runs, and a reader must never see the trace
    // briefly empty.
    await this.query(
      `INSERT INTO events (match_id, seq, data)
       SELECT $1, (e->>'seq')::int, e FROM jsonb_array_elements($2::jsonb) AS e
       ON CONFLICT (match_id, seq) DO UPDATE SET data = EXCLUDED.data`,
      [matchId, JSON.stringify(events)],
    );
  }

  async getEvents(matchId: string): Promise<ExecutionEvent[]> {
    return this.rows<ExecutionEvent>("SELECT data FROM events WHERE match_id = $1 ORDER BY seq ASC", [
      matchId,
    ]);
  }

  async saveToolCalls(executionId: string, calls: ToolCall[]): Promise<void> {
    await this.replaceIndexed("tool_calls", executionId, calls);
  }

  async getToolCalls(executionId: string): Promise<ToolCall[]> {
    return this.rows<ToolCall>(
      "SELECT data FROM tool_calls WHERE execution_id = $1 ORDER BY idx ASC",
      [executionId],
    );
  }

  async saveArtifacts(executionId: string, artifacts: Artifact[]): Promise<void> {
    await this.replaceIndexed("artifacts", executionId, artifacts);
  }

  async getArtifacts(executionId: string): Promise<Artifact[]> {
    return this.rows<Artifact>(
      "SELECT data FROM artifacts WHERE execution_id = $1 ORDER BY idx ASC",
      [executionId],
    );
  }

  /** Ordered child rows are written as a set: replace, don't merge. */
  private async replaceIndexed(table: "tool_calls" | "artifacts", executionId: string, items: unknown[]) {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${table} WHERE execution_id = $1`, [executionId]);
      if (items.length > 0) {
        await client.query(
          `INSERT INTO ${table} (execution_id, idx, data)
           SELECT $1, (ordinality - 1)::int, value
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY`,
          [executionId, JSON.stringify(items)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async connect() {
    await this.migrate();
    return this.pool.connect();
  }

  async saveEvaluation(evaluation: Evaluation): Promise<void> {
    await this.query(
      `INSERT INTO evaluations (execution_id, data) VALUES ($1, $2)
       ON CONFLICT (execution_id) DO UPDATE SET data = EXCLUDED.data`,
      [evaluation.executionId, evaluation],
    );
  }

  async getEvaluation(executionId: string): Promise<Evaluation | null> {
    return this.one<Evaluation>("SELECT data FROM evaluations WHERE execution_id = $1", [executionId]);
  }

  async saveScore(score: Score): Promise<void> {
    await this.query(
      `INSERT INTO scores (execution_id, data) VALUES ($1, $2)
       ON CONFLICT (execution_id) DO UPDATE SET data = EXCLUDED.data`,
      [score.executionId, score],
    );
  }

  async getScore(executionId: string): Promise<Score | null> {
    return this.one<Score>("SELECT data FROM scores WHERE execution_id = $1", [executionId]);
  }

  // ── ranking ───────────────────────────────────────────────────────────────

  async getRating(agentId: string, seasonId: string, scope: string): Promise<Rating | null> {
    return this.one<Rating>(
      "SELECT data FROM ratings WHERE agent_id = $1 AND season_id = $2 AND scope = $3",
      [agentId, seasonId, scope],
    );
  }

  async saveRating(rating: Rating): Promise<void> {
    await this.query(
      `INSERT INTO ratings (season_id, scope, agent_id, rating, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (season_id, scope, agent_id) DO UPDATE SET
         rating = EXCLUDED.rating, data = EXCLUDED.data`,
      [rating.seasonId, rating.scope, rating.agentId, rating.rating, rating],
    );
  }

  async listRatings(seasonId: string, scope: string): Promise<Rating[]> {
    return this.rows<Rating>(
      "SELECT data FROM ratings WHERE season_id = $1 AND scope = $2 ORDER BY rating DESC",
      [seasonId, scope],
    );
  }

  // ── seasons ───────────────────────────────────────────────────────────────

  async listSeasons(): Promise<Season[]> {
    return this.rows<Season>("SELECT data FROM seasons ORDER BY number DESC");
  }

  async getSeason(id: string): Promise<Season | null> {
    return this.one<Season>("SELECT data FROM seasons WHERE id = $1", [id]);
  }

  async activeSeason(): Promise<Season> {
    const active = await this.one<Season>(
      "SELECT data FROM seasons WHERE status = 'active' ORDER BY number DESC LIMIT 1",
    );
    if (active) return active;
    const newest = await this.one<Season>("SELECT data FROM seasons ORDER BY number DESC LIMIT 1");
    if (newest) return newest;
    throw new Error("no season exists — the store was not seeded");
  }

  async saveSeason(season: Season): Promise<void> {
    await this.query(
      `INSERT INTO seasons (id, number, status, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         number = EXCLUDED.number, status = EXCLUDED.status, data = EXCLUDED.data`,
      [season.id, season.number, season.status, season],
    );
  }

  // ── votes ─────────────────────────────────────────────────────────────────

  async castVote(matchId: string, voterId: string, side: "A" | "B"): Promise<void> {
    await this.query(
      `INSERT INTO votes (match_id, voter_id, side, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (match_id, voter_id) DO UPDATE SET side = EXCLUDED.side, created_at = EXCLUDED.created_at`,
      [matchId, voterId, side, Date.now()],
    );
  }

  async getVotes(matchId: string, voterId?: string): Promise<{ A: number; B: number; mine: "A" | "B" | null }> {
    const rows = await this.query<{ side: "A" | "B"; voter_id: string }>(
      "SELECT side, voter_id FROM votes WHERE match_id = $1",
      [matchId],
    );
    let a = 0;
    let b = 0;
    let mine: "A" | "B" | null = null;
    for (const row of rows) {
      if (row.side === "A") a += 1;
      else b += 1;
      if (voterId && row.voter_id === voterId) mine = row.side;
    }
    return { A: a, B: b, mine };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Writes are already durable when they return; nothing is buffered. */
  async flush(): Promise<void> {
    await this.migrate();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Empty every table. Exposed for the conformance suite, which asserts on
   * exact contents and so must own the database it runs against. Guarded
   * because a stray call in production would delete the arena.
   */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("truncateAll is not available in production");
    }
    await this.query(`TRUNCATE agents, agent_versions, matches, executions, events,
                      tool_calls, artifacts, evaluations, scores, ratings, seasons, votes
                      RESTART IDENTITY CASCADE`);
    await this.query("SELECT setval('match_number_seq', $1)", [FIRST_MATCH_NUMBER - 1]);
  }

  get isPersistent(): boolean {
    return true;
  }

  /** Host and database only — a connection string carries a password. */
  get location(): string {
    return this.label;
  }
}

/**
 * Hosted Postgres (Neon, Supabase, Railway, Render) terminates TLS at a proxy
 * whose certificate chain is frequently not in the container's trust store, so
 * verification is relaxed for remote hosts while the connection stays
 * encrypted. A local socket needs no TLS at all.
 */
function needsSsl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") === "disable") return false;
    return !["localhost", "127.0.0.1", "::1", ""].includes(url.hostname);
  } catch {
    return false;
  }
}

/** `postgres://user:secret@host:5432/db` → `host:5432/db`. Never the password. */
function safeLabel(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `postgres ${url.host}${url.pathname}`;
  } catch {
    return "postgres";
  }
}
