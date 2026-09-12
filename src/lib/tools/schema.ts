import { z } from "zod";

/**
 * Shared validators, so every tool rejects paths identically. Kept in its own
 * module because the registry imports the tools and the tools import this —
 * putting it in the registry would be a cycle.
 */
export const pathSchema = z
  .string()
  .min(1, "path is required")
  .max(180, "path is too long")
  .refine((p) => !p.includes(String.fromCharCode(0)), "path contains a null byte");
