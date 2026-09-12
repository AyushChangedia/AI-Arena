import { z } from "zod";
import { defineTool } from "./types";

/**
 * Executes JavaScript in the sandboxed code executor. Source is written to the
 * workspace first so it is inspectable, reviewable, and gradeable afterwards —
 * an agent cannot pass a task with code that never existed as a file.
 */
export const codeTool = defineTool({
  spec: {
    name: "code.run",
    title: "Run code",
    description:
      "Execute JavaScript in the sandbox. Either pass `source` (saved to the workspace and run) " +
      "or `path` (run an existing workspace file). CommonJS require() resolves JS and JSON within " +
      "the workspace; readFile(path), fileExists(path) and listFiles() read any workspace file. " +
      "No network, no timers, no host access, and no way to write files — use file.write for that. " +
      "Synchronous code only.",
    permission: "execute",
    timeoutMs: 12_000,
    cost: 0,
    parameters: {
      source: { type: "string", description: "JavaScript to execute", required: false },
      path: { type: "string", description: "Existing workspace file to run", required: false },
      saveAs: {
        type: "string",
        description: "Where to save `source` (default /scratch/run.js)",
        required: false,
      },
    },
  },
  schema: z
    .object({
      source: z.string().max(200_000).optional(),
      path: z.string().max(180).optional(),
      saveAs: z.string().max(180).optional(),
    })
    .refine((v) => Boolean(v.source) !== Boolean(v.path), {
      message: "provide exactly one of `source` or `path`",
    }),
  async execute(args, ctx) {
    if (!ctx.executor.available) {
      return {
        ok: false,
        output: "",
        error: ctx.executor.unavailableReason ?? "code execution is unavailable",
      };
    }

    let entry: string;
    if (args.source !== undefined) {
      entry = args.saveAs ?? "/scratch/run.js";
      try {
        ctx.vfs.write(entry, args.source);
      } catch (e) {
        return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      entry = args.path!;
    }

    const r = ctx.executor.run(ctx.vfs, { entry, timeoutMs: 10_000 });
    const parts = [r.stdout, r.stderr].filter(Boolean);
    if (r.value !== null && r.value !== undefined) {
      parts.push(`[exports] ${JSON.stringify(r.value)}`);
    }
    const output = parts.join("\n");

    if (r.ok) {
      return {
        ok: true,
        output: output || "(no output)",
        error: null,
        meta: { entry, durationMs: r.durationMs, truncated: r.truncated },
      };
    }
    return {
      ok: false,
      output: r.stdout,
      error: `${r.error?.name ?? "Error"}: ${r.error?.message ?? "execution failed"}`,
      meta: { entry, durationMs: r.durationMs, timedOut: r.timedOut },
    };
  },
});
