import type { Agent, AgentConfig, Season } from "@/lib/arena/types";
import type { ArenaStore } from "./types";
import { hashOf } from "@/lib/arena/ids";

/**
 * Seed roster.
 *
 * These agents declare the model they are *configured* for. When that provider
 * has no API key the arena substitutes a scripted policy and labels the match
 * DEMO everywhere — it never claims the named model produced the run. Add a key
 * and the same agent runs live against the same tasks and graders.
 *
 * They are also not equally good, and they do not all win. The Speedrunner is
 * fast and careless and loses coding tasks it could have won; that is the point
 * of having a leaderboard at all.
 */

export const OWNER_ID = "user_local";

const base = {
  memory: "session" as const,
  temperature: null,
  visibility: "public" as const,
};

const ALL_TOOLS = ["file.read", "file.write", "file.list", "file.delete", "shell.exec", "code.run", "web.search", "web.fetch"];
const BUILD_TOOLS = ["file.read", "file.write", "file.list", "shell.exec", "code.run"];
const RESEARCH_TOOLS = ["web.search", "web.fetch", "file.read", "file.write", "file.list"];

export const SEED_CONFIGS: AgentConfig[] = [
  {
    name: "The Architect",
    handle: "architect",
    tagline: "Reads everything first. Writes once.",
    description:
      "Explores the environment before touching it, then makes a single deliberate change. " +
      "Slow to start and hard to beat on tasks where the defect is not where it appears to be.",
    model: { provider: "anthropic", model: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    systemPrompt:
      "You are a senior engineer who has been burned by hasty fixes. Read the code and the " +
      "tests before you change anything. Identify every defect, not just the first one. " +
      "Make one correct change rather than three speculative ones, then verify it.",
    tools: BUILD_TOOLS,
    planning: "deep",
    maxSteps: 30,
    timeLimitMs: 180_000,
    budgetUsd: 0.6,
    emblem: "AR",
    accent: "amber",
    ...base,
  },
  {
    name: "The Shipper",
    handle: "shipper",
    tagline: "Working beats elegant.",
    description:
      "Goes straight at the deliverable and iterates from real feedback. Wins on breadth " +
      "tasks with a clear target; loses where the first obvious answer is the wrong one.",
    model: { provider: "openai", model: "gpt-5", label: "GPT-5" },
    systemPrompt:
      "You ship. Produce the deliverable first, then check it against the requirements and " +
      "fix what is actually wrong. Do not gold-plate. Do not explore for its own sake.",
    tools: ALL_TOOLS,
    planning: "reactive",
    maxSteps: 24,
    timeLimitMs: 150_000,
    budgetUsd: 0.5,
    emblem: "SH",
    accent: "cyan",
    ...base,
  },
  {
    name: "Research Beast",
    handle: "research-beast",
    tagline: "Reads the primary source or does not cite it.",
    description:
      "Searches widely, fetches in full, and refuses to write from snippets. Built for " +
      "source-heavy work; carries no advantage on a coding task.",
    model: { provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    systemPrompt:
      "You are a research analyst. Search broadly, then fetch and read every document you " +
      "intend to cite — never write from a search snippet. Weigh sources by quality and say " +
      "so when one is unreliable. Every claim gets a URL.",
    tools: RESEARCH_TOOLS,
    planning: "deep",
    maxSteps: 28,
    timeLimitMs: 180_000,
    budgetUsd: 0.6,
    emblem: "RB",
    accent: "amber",
    ...base,
  },
  {
    name: "The Debugger",
    handle: "debugger",
    tagline: "Reproduce, then fix. Never the other way round.",
    description:
      "Runs the failing case before proposing a cause, and re-runs after every change. " +
      "Strong on repair work, middling where there is nothing to reproduce.",
    model: { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6" },
    systemPrompt:
      "You debug by evidence. Run the failing case first and read the actual error. Form one " +
      "hypothesis, change one thing, re-run. If the error changes, you learned something; if " +
      "it does not, your hypothesis was wrong — say so and form another.",
    tools: BUILD_TOOLS,
    planning: "balanced",
    maxSteps: 26,
    timeLimitMs: 180_000,
    budgetUsd: 0.5,
    emblem: "DB",
    accent: "cyan",
    ...base,
  },
  {
    name: "The Generalist",
    handle: "generalist",
    tagline: "No specialism. No blind spots either.",
    description:
      "Every tool, middling depth, no strong preferences. Rarely the best agent on a task " +
      "and rarely the worst — the baseline the specialists are measured against.",
    model: { provider: "openai", model: "gpt-4.1", label: "GPT-4.1" },
    systemPrompt:
      "You handle whatever the task is. Read enough to understand the requirements, make a " +
      "plan proportional to the difficulty, execute it, and verify the result before stopping.",
    tools: ALL_TOOLS,
    planning: "balanced",
    maxSteps: 26,
    timeLimitMs: 170_000,
    budgetUsd: 0.5,
    emblem: "GN",
    accent: "neutral",
    ...base,
  },
  {
    name: "The Speedrunner",
    handle: "speedrunner",
    tagline: "Ten steps or it does not count.",
    description:
      "A hard ten-step ceiling and no exploration. Posts the best efficiency numbers in the " +
      "arena and loses matches it should have won by skipping the verification step.",
    model: { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    systemPrompt:
      "You optimise for steps. Do not read what you can infer. Do not verify what is " +
      "obviously right. Produce the deliverable in as few tool calls as possible.",
    tools: BUILD_TOOLS,
    planning: "reactive",
    maxSteps: 10,
    timeLimitMs: 90_000,
    budgetUsd: 0.25,
    emblem: "SP",
    accent: "amber",
    ...base,
  },
];

export const SEASON_ONE: Season = {
  id: "season_01",
  number: 1,
  name: "The First Circuit",
  startsAt: Date.UTC(2026, 0, 1),
  endsAt: Date.UTC(2026, 11, 31, 23, 59, 59),
  status: "active",
  awards: [
    { key: "champion", title: "Champion", description: "Highest overall rating at close", agentId: null, value: null },
    { key: "best_coder", title: "Best Coder", description: "Highest rating in coding", agentId: null, value: null },
    { key: "best_researcher", title: "Best Researcher", description: "Highest rating in research", agentId: null, value: null },
    { key: "most_efficient", title: "Most Efficient", description: "Best mean efficiency across rated matches", agentId: null, value: null },
    { key: "best_recovery", title: "Best Recovery", description: "Highest recovery rate over 3+ failures", agentId: null, value: null },
    { key: "most_improved", title: "Most Improved", description: "Largest rating gain from first rated match", agentId: null, value: null },
    { key: "rookie", title: "Rookie of the Season", description: "Best rating among agents created this season", agentId: null, value: null },
  ],
};

export async function seedIfEmpty(store: ArenaStore): Promise<void> {
  const seasons = await store.listSeasons();
  if (seasons.length === 0) await store.saveSeason(SEASON_ONE);

  const existing = await store.listAgents();
  if (existing.length > 0) return;

  const now = Date.now();
  for (const [index, config] of SEED_CONFIGS.entries()) {
    const agent: Agent = {
      id: `agent_${config.handle}`,
      ownerId: OWNER_ID,
      visibility: "public",
      config,
      configHash: hashOf(config),
      // Staggered so the roster has a stable, non-identical creation order.
      createdAt: now - (SEED_CONFIGS.length - index) * 86_400_000,
      updatedAt: now - (SEED_CONFIGS.length - index) * 86_400_000,
      origin: "seed",
    };
    await store.createAgent(agent);
    await store.createAgentVersion({
      id: `ver_${config.handle}_1`,
      agentId: agent.id,
      version: 1,
      config,
      configHash: agent.configHash,
      createdAt: agent.createdAt,
    });
  }
}
