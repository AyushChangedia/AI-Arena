import { z } from "zod";
import { defineTool } from "./types";

/**
 * Runs a command in the VIRTUAL shell — an interpreter over the in-memory
 * workspace, not a host shell. See lib/sandbox/shell.ts.
 */
export const shellTool = defineTool({
  spec: {
    name: "shell.exec",
    title: "Shell",
    description:
      "Run a command in the workspace shell. Supports ls, cat, echo, mkdir, touch, rm, cp, mv, " +
      "grep, find, wc, head, tail, pwd, cd, node, and any scripts the task registers (e.g. npm test). " +
      "Pipes, redirects and && sequencing work. There is no network and no package registry.",
    permission: "execute",
    timeoutMs: 12_000,
    cost: 0,
    parameters: {
      command: { type: "string", description: "The command line to run", required: true },
    },
  },
  schema: z.object({
    command: z.string().min(1, "command is required").max(4000, "command line too long"),
  }),
  async execute(args, ctx) {
    const r = await ctx.shell.exec(args.command);
    const body = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (r.exitCode === 0) {
      return {
        ok: true,
        output: body || "(no output)",
        error: null,
        meta: { exitCode: 0, durationMs: r.durationMs, command: args.command },
      };
    }
    return {
      ok: false,
      output: r.stdout,
      error: r.stderr || `command exited with code ${r.exitCode}`,
      meta: { exitCode: r.exitCode, durationMs: r.durationMs, command: args.command },
    };
  },
});
