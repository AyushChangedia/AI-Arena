import type { Task, TaskCategory } from "@/lib/arena/types";
import type { TaskDefinition } from "./types";
import { repairAuth } from "./definitions/repair-auth";
import { rateLimiter } from "./definitions/rate-limiter";
import { landingPage } from "./definitions/landing-page";
import { vectorDbResearch } from "./definitions/vector-db-research";
import { salesAnalysis } from "./definitions/sales-analysis";
import { oncallRotation } from "./definitions/oncall-rotation";

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

export function allTaskDefinitions(): TaskDefinition[] {
  return DEFINITIONS;
}

/** Serialisable task records — safe to send to the browser. */
export function allTasks(): Task[] {
  return DEFINITIONS.map((d) => d.task);
}

export function getTaskDefinition(idOrSlug: string): TaskDefinition | undefined {
  return BY_ID.get(idOrSlug) ?? BY_SLUG.get(idOrSlug);
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
