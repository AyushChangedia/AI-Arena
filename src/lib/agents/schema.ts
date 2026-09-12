import { z } from "zod";
import { BRIEF_MAX, BRIEF_MIN } from "@/lib/tasks/brief";
import { TOOL_NAMES } from "@/lib/tools/registry";
import type { AgentConfig } from "@/lib/arena/types";

/**
 * The agent configuration contract.
 *
 * Shared by the API and the builder, so the form and the endpoint enforce
 * exactly the same rules and the client can show a field error before a round
 * trip rather than after one.
 */

export const LIMITS = {
  name: { min: 2, max: 40 },
  tagline: { max: 80 },
  description: { max: 400 },
  systemPrompt: { min: 20, max: 4_000 },
  maxSteps: { min: 3, max: 40 },
  timeLimitSec: { min: 30, max: 600 },
  budgetUsd: { min: 0.05, max: 5 },
} as const;

export const agentConfigSchema = z.object({
  name: z
    .string()
    .trim()
    .min(LIMITS.name.min, `Name must be at least ${LIMITS.name.min} characters.`)
    .max(LIMITS.name.max, `Name must be ${LIMITS.name.max} characters or fewer.`),
  tagline: z.string().trim().max(LIMITS.tagline.max, "Keep the tagline short.").default(""),
  description: z.string().trim().max(LIMITS.description.max, "Keep the description under 400 characters.").default(""),
  model: z.object({
    provider: z.enum(["openrouter", "anthropic", "openai", "google", "scripted"]),
    model: z.string().trim().min(1, "Pick a model.").max(80),
    label: z.string().trim().min(1).max(60),
  }),
  systemPrompt: z
    .string()
    .trim()
    .min(LIMITS.systemPrompt.min, "A system prompt of at least 20 characters gives the agent something to work with.")
    .max(LIMITS.systemPrompt.max, "System prompt is too long."),
  tools: z
    .array(z.string())
    .min(1, "An agent needs at least one tool.")
    .refine((tools) => tools.every((t) => TOOL_NAMES.includes(t)), {
      message: "Unknown tool selected.",
    }),
  planning: z.enum(["reactive", "balanced", "deep"]),
  memory: z.enum(["none", "session", "persistent"]),
  maxSteps: z.number().int().min(LIMITS.maxSteps.min).max(LIMITS.maxSteps.max),
  timeLimitMs: z
    .number()
    .int()
    .min(LIMITS.timeLimitSec.min * 1000)
    .max(LIMITS.timeLimitSec.max * 1000),
  budgetUsd: z.number().min(LIMITS.budgetUsd.min).max(LIMITS.budgetUsd.max),
  temperature: z.number().min(0).max(2).nullable(),
  emblem: z
    .string()
    .trim()
    .min(1, "Pick an emblem.")
    .max(2, "An emblem is one or two characters.")
    .transform((s) => s.toUpperCase()),
  accent: z.enum(["amber", "cyan", "neutral"]),
});

export const createAgentSchema = z.object({
  config: agentConfigSchema,
  visibility: z.enum(["public", "private"]).default("public"),
});

export const updateAgentSchema = z.object({
  config: agentConfigSchema.partial(),
  visibility: z.enum(["public", "private"]).optional(),
});

export const createMatchSchema = z
  .object({
    /** A task from the library. */
    taskId: z.string().min(1).optional(),
    /** A brief typed by a visitor. Bounded here because it becomes a prompt. */
    brief: z.string().min(BRIEF_MIN).max(BRIEF_MAX).optional(),
    agentAId: z.string().min(1, "Pick the first agent."),
    agentBId: z.string().min(1, "Pick the second agent."),
    seed: z.string().max(80).optional(),
    rated: z.boolean().optional(),
  })
  // Exactly one source of the task. Accepting both would leave it ambiguous
  // which one the agents were actually given.
  .refine((v) => Boolean(v.taskId) !== Boolean(v.brief), {
    message: "Give either a task or a brief, not both.",
    path: ["taskId"],
  });

export type AgentConfigInput = z.input<typeof agentConfigSchema>;

/** Defaults for a brand-new agent in the builder. */
export function blankAgentConfig(): AgentConfig {
  return {
    name: "",
    handle: "",
    tagline: "",
    description: "",
    model: { provider: "scripted", model: "policy", label: "Scripted policy" },
    systemPrompt:
      "You are a careful engineer. Read before you write, verify before you finish, and never " +
      "claim to have done something you did not do.",
    tools: ["file.read", "file.write", "file.list", "shell.exec", "code.run"],
    planning: "balanced",
    memory: "session",
    maxSteps: 24,
    timeLimitMs: 150_000,
    budgetUsd: 0.5,
    temperature: null,
    emblem: "NA",
    accent: "cyan",
  };
}
