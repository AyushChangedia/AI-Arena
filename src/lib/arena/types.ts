/**
 * AI AGENT ARENA — core domain model.
 *
 * These types are the contract every layer agrees on. Nothing here imports
 * anything: it is the bottom of the dependency graph on purpose.
 */

// ─── Identity ────────────────────────────────────────────────────────────────

export type Id = string;
export type Side = "A" | "B";

// ─── Providers & models ──────────────────────────────────────────────────────

export type ProviderId = "openrouter" | "anthropic" | "openai" | "google" | "scripted";

/** How a match was driven. The single most important honesty flag in the app. */
export type ExecutionMode =
  /** A real model made every decision. */
  | "live"
  /** A deterministic scripted policy made the decisions; everything else is real. */
  | "demo";

export interface ModelRef {
  provider: ProviderId;
  /** Provider-native model identifier, or a policy id for `scripted`. */
  model: string;
  /** Display name shown on agent cards. */
  label: string;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export type PlanningMode = "reactive" | "balanced" | "deep";
export type MemoryMode = "none" | "session" | "persistent";

/** The full definition of an agent. Model is one field of many, deliberately. */
export interface AgentConfig {
  name: string;
  handle: string;
  tagline: string;
  description: string;
  model: ModelRef;
  systemPrompt: string;
  tools: string[];
  planning: PlanningMode;
  memory: MemoryMode;
  maxSteps: number;
  timeLimitMs: number;
  budgetUsd: number;
  temperature: number | null;
  /** Two-letter emblem drawn in the agent's accent. No avatars. */
  emblem: string;
  accent: "amber" | "cyan" | "neutral";
}

export interface Agent {
  id: Id;
  ownerId: Id;
  visibility: "public" | "private";
  config: AgentConfig;
  /** Content hash of `config` — pinned by every match this version ran. */
  configHash: string;
  createdAt: number;
  updatedAt: number;
  origin: "seed" | "user";
}

export interface AgentVersion {
  id: Id;
  agentId: Id;
  version: number;
  config: AgentConfig;
  configHash: string;
  createdAt: number;
}

/** Aggregate record, derived from matches. Never hand-written. */
export interface AgentRecord {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  avgScore: number | null;
  successRate: number | null;
  recoveryRate: number | null;
  avgCostUsd: number | null;
  avgDurationMs: number | null;
  demoShare: number | null;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export type TaskCategory =
  | "coding"
  | "debugging"
  | "research"
  | "data"
  | "ui"
  | "automation"
  | "reasoning";

export type Difficulty = "easy" | "medium" | "hard" | "expert";

export interface TaskLimits {
  timeLimitMs: number;
  stepLimit: number;
  budgetUsd: number;
}

/** A seed file placed into both agents' environments before the match. */
export interface SeedFile {
  path: string;
  content: string;
  /** Shown in the task page so entrants know the starting state. */
  note?: string;
}

export interface Task {
  id: Id;
  slug: string;
  title: string;
  brief: string;
  /** The prompt handed verbatim and identically to both agents. */
  prompt: string;
  category: TaskCategory;
  difficulty: Difficulty;
  limits: TaskLimits;
  toolsAllowed: string[];
  successConditions: string[];
  /** Which evaluators apply, and the weights used to fold metrics into a score. */
  evaluation: {
    evaluators: string[];
    weights: Record<string, number>;
    /** Set when this task overrides its category defaults. */
    weightsOverridden: boolean;
  };
  seedFiles: SeedFile[];
  /** Primary artifact the agent must produce. Drives the artifact viewer. */
  targetArtifact: { path: string; kind: ArtifactKind } | null;
}

// ─── Sandbox / tools ─────────────────────────────────────────────────────────

export type ToolPermission = "read" | "write" | "execute" | "network";

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  permission: ToolPermission;
  timeoutMs: number;
  /** Fixed cost in USD charged against the agent's budget per call. */
  cost: number;
  /** JSON-schema-ish shape rendered in the UI and sent to providers. */
  parameters: Record<string, ToolParam>;
}

export interface ToolParam {
  type: "string" | "number" | "boolean" | "string[]";
  description: string;
  required: boolean;
  enum?: string[];
}

export interface ToolCall {
  id: Id;
  executionId: Id;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  status: "ok" | "error";
  durationMs: number;
  /** Truncated for storage; full output lives in the VFS when it is a file. */
  output: string;
  error: string | null;
  costUsd: number;
  startedAt: number;
  /** Set when a tool produced data from a bundled corpus rather than the web. */
  provenance?: "offline-corpus" | "live-web";
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

export type ArtifactKind = "html" | "code" | "markdown" | "json" | "csv" | "text";

export interface Artifact {
  id: Id;
  executionId: Id;
  path: string;
  kind: ArtifactKind;
  bytes: number;
  content: string;
  createdAt: number;
  /** True for the task's declared target artifact. */
  primary: boolean;
}

// ─── Execution ───────────────────────────────────────────────────────────────

export type AgentState =
  | "idle"
  | "planning"
  | "thinking"
  | "searching"
  | "executing"
  | "waiting"
  | "recovering"
  | "blocked"
  | "succeeded"
  | "failed";

export type ExecutionEventType =
  | "agent.started"
  | "agent.planning"
  | "agent.thinking"
  | "agent.message"
  | "agent.tool_called"
  | "agent.tool_completed"
  | "agent.tool_failed"
  | "agent.file_created"
  | "agent.file_modified"
  | "agent.command_executed"
  | "agent.command_failed"
  | "agent.recovery_started"
  | "agent.recovery_completed"
  | "agent.artifact_created"
  | "agent.state_changed"
  | "agent.limit_reached"
  | "agent.task_completed"
  | "agent.task_failed"
  | "eval.started"
  | "eval.dimension"
  | "eval.completed"
  | "match.started"
  | "match.completed";

export interface ExecutionEvent {
  id: Id;
  /** Monotonic within a match. Ordering key for replay. */
  seq: number;
  matchId: Id;
  executionId: Id | null;
  agentId: Id | null;
  side: Side | null;
  type: ExecutionEventType;
  /** Wall-clock epoch ms. */
  at: number;
  /** Ms since match start. The replay timeline's x-axis. */
  t: number;
  step: number;
  label: string;
  detail?: string;
  tool?: string;
  status?: "ok" | "error" | "pending";
  durationMs?: number;
  state?: AgentState;
  data?: Record<string, unknown>;
}

export type ExecutionOutcome =
  | "completed"
  | "failed"
  | "timeout"
  | "step_limit"
  | "budget_exceeded"
  | "provider_error"
  | "cancelled";

export interface ExecutionUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

export interface Execution {
  id: Id;
  matchId: Id;
  agentId: Id;
  side: Side;
  mode: ExecutionMode;
  provider: ProviderId;
  model: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  steps: number;
  outcome: ExecutionOutcome | null;
  state: AgentState;
  usage: ExecutionUsage;
  /** The agent's own closing statement, if it produced one. */
  finalMessage: string | null;
  error: string | null;
}

// ─── Evaluation & scoring ────────────────────────────────────────────────────

export type MetricKey = string;

export interface Metric {
  key: MetricKey;
  /** Raw measured value in its natural unit. Never normalised here. */
  value: number | null;
  unit: "count" | "ratio" | "ms" | "usd" | "score";
  label: string;
  /** Null value + a reason renders as "NOT CONFIGURED" / "UNAVAILABLE". */
  unavailableReason?: string;
}

export interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

export interface RubricCheckResult {
  id: string;
  name: string;
  weight: number;
  passed: boolean;
  score: number;
  message: string;
}

export interface Evaluation {
  id: Id;
  executionId: Id;
  metrics: Metric[];
  tests: TestResult[];
  rubric: RubricCheckResult[];
  notes: string[];
  /** Evaluators that could not run, and why. Surfaced in the UI. */
  unavailable: { evaluator: string; dimension: string; reason: string }[];
  createdAt: number;
}

export interface ScoreDimension {
  key: MetricKey;
  label: string;
  weight: number;
  /** Weight after redistribution of unavailable dimensions. */
  effectiveWeight: number;
  raw: number | null;
  normalised: number | null;
  contribution: number;
  available: boolean;
  reason?: string;
}

export interface Score {
  id: Id;
  executionId: Id;
  total: number;
  dimensions: ScoreDimension[];
  createdAt: number;
}

// ─── Matches ─────────────────────────────────────────────────────────────────

export type MatchStatus = "pending" | "running" | "evaluating" | "complete" | "failed";
export type MatchResult = "A" | "B" | "draw" | "double_failure" | null;

export interface MatchParticipant {
  side: Side;
  agentId: Id;
  /** Pinned so editing an agent never rewrites the meaning of past matches. */
  configHash: string;
  configSnapshot: AgentConfig;
  executionId: Id | null;
  scoreTotal: number | null;
  ratingBefore: number;
  ratingAfter: number | null;
}

export interface Match {
  id: Id;
  number: number;
  taskId: Id;
  /**
   * The brief this match was built from, when it came from a typed request
   * rather than the task library. Stored on the match because a custom task
   * cannot be recovered from its id — the id is a hash of this text — and any
   * instance may need to rebuild it to read the match back.
   */
  customBrief?: string | null;
  seasonId: Id;
  mode: ExecutionMode;
  status: MatchStatus;
  result: MatchResult;
  participants: [MatchParticipant, MatchParticipant];
  /** Deterministic environment seed. Both sides get an identical build from it. */
  seed: string;
  /** Hash of the materialised starting VFS, asserted equal for both sides. */
  envHash: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  rated: boolean;
  error: string | null;
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

export interface Rating {
  agentId: Id;
  seasonId: Id;
  /** "overall" or a TaskCategory. */
  scope: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  peak: number;
  updatedAt: number;
}

export interface Season {
  id: Id;
  number: number;
  name: string;
  startsAt: number;
  endsAt: number;
  status: "upcoming" | "active" | "closed";
  awards: SeasonAward[];
}

export interface SeasonAward {
  key: string;
  title: string;
  description: string;
  /** Null until the season closes or enough matches exist to decide it. */
  agentId: Id | null;
  value: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  agent: Agent;
  rating: Rating;
  record: AgentRecord;
}

// ─── Replay ──────────────────────────────────────────────────────────────────

export interface Replay {
  matchId: Id;
  durationMs: number;
  events: ExecutionEvent[];
  /** Precomputed per-side step boundaries for the scrubber's tick marks. */
  markers: { t: number; side: Side | null; type: ExecutionEventType; label: string }[];
}
