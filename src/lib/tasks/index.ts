import type { Task, TaskCategory } from "@/lib/arena/types";
import type { TaskDefinition } from "./types";
import { repairAuth } from "./definitions/repair-auth";
import { rateLimiter } from "./definitions/rate-limiter";
import { landingPage } from "./definitions/landing-page";
import { vectorDbResearch } from "./definitions/vector-db-research";
import { salesAnalysis } from "./definitions/sales-analysis";
import { oncallRotation } from "./definitions/oncall-rotation";
import { buildCustomTask } from "./custom";

const DEFINITIONS: TaskDefinition[] = [
  repairAuth,
  rateLimiter,
  landingPage,
  vectorDbResearch,
  salesAnalysis,
  oncallRotation,
];

const BY_ID = new Map(DEFINITIONS.map((d) => [d.task.id, d]));
const BY_SLUG = new Map(DEFINITIONS.map((d) => [d.task.slug, d]));

/**
 * Tasks built from a typed brief.
 *
 * Held per process and rebuilt on demand rather than stored: the definition is
 * a pure function of the brief text, and the brief travels on the match, so any
 * instance can reconstruct exactly the same task — same prompt, same
 * assertions, same policy — without the two ever having to agree in advance.
 * Bounded so a stream of one-off briefs cannot grow it without limit.
 */
const CUSTOM = new Map<string, TaskDefinition>();
const MAX_CUSTOM = 200;

export function registerCustomTask(brief: string): TaskDefinition {
  const definition = buildCustomTask(brief);
  const { id, slug } = definition.task;
  if (!CUSTOM.has(id) && CUSTOM.size >= MAX_CUSTOM) {
    const oldest = CUSTOM.keys().next().value;
    if (oldest !== undefined) CUSTOM.delete(oldest);
  }
  CUSTOM.set(id, definition);
  CUSTOM.set(slug, definition);
  return definition;
}

/** Re-registers the task for a match that carries a brief. Cheap and idempotent. */
export function ensureCustomTask(match: { taskId: string; customBrief?: string | null }): void {
  if (!match.customBrief) return;
  if (CUSTOM.has(match.taskId)) return;
  registerCustomTask(match.customBrief);
}

export function isCustomTaskId(taskId: string): boolean {
  return taskId.startsWith("task_custom_");
}

export function allTaskDefinitions(): TaskDefinition[] {
  return DEFINITIONS;
}

/** Serialisable task records — safe to send to the browser. */
export function allTasks(): Task[] {
  return DEFINITIONS.map((d) => d.task);
}

export function getTaskDefinition(idOrSlug: string): TaskDefinition | undefined {
  return BY_ID.get(idOrSlug) ?? BY_SLUG.get(idOrSlug) ?? CUSTOM.get(idOrSlug);
}

export function getTask(idOrSlug: string): Task | undefined {
  return getTaskDefinition(idOrSlug)?.task;
}

export function tasksByCategory(category: TaskCategory): Task[] {
  return allTasks().filter((t) => t.category === category);
}

export const TASK_CATEGORIES: { id: TaskCategory; label: string; blurb: string }[] = [
  { id: "coding", label: "Coding", blurb: "Build it from nothing. Tests decide." },
  { id: "debugging", label: "Debugging", blurb: "Someone else's defect, your repair." },
  { id: "research", label: "Research", blurb: "Read, discriminate, cite." },
  { id: "data", label: "Data", blurb: "The export is lying. Find out how." },
  { id: "ui", label: "UI", blurb: "Structure, accessibility, and copy that isn't marketing." },
  { id: "reasoning", label: "Reasoning", blurb: "Constraints that interact. Verify or lose." },
  { id: "automation", label: "Automation", blurb: "Make the machine do it." },
];
