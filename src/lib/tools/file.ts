import { z } from "zod";
import { defineTool } from "./types";
import { pathSchema } from "./schema";
import { VfsError, fmtBytes } from "@/lib/sandbox/vfs";

const READ_LIMIT = 40_000;

const fileRead = defineTool({
  spec: {
    name: "file.read",
    title: "Read file",
    description:
      "Read a UTF-8 text file from the workspace. Returns the full contents, or a line range.",
    permission: "read",
    timeoutMs: 2_000,
    cost: 0,
    parameters: {
      path: { type: "string", description: "Workspace path, e.g. src/auth.js", required: true },
      startLine: { type: "number", description: "1-indexed first line", required: false },
      endLine: { type: "number", description: "1-indexed last line, inclusive", required: false },
    },
  },
  schema: z.object({
    path: pathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  async execute(args, ctx) {
    try {
      const content = ctx.vfs.read(args.path);
      if (args.startLine || args.endLine) {
        const lines = content.split("\n");
        const from = (args.startLine ?? 1) - 1;
        const to = args.endLine ?? lines.length;
        const slice = lines
          .slice(from, to)
          .map((l, i) => `${String(from + i + 1).padStart(4)}  ${l}`)
          .join("\n");
        return { ok: true, output: slice, error: null, meta: { path: args.path } };
      }
      return {
        ok: true,
        output: content.length > READ_LIMIT ? `${content.slice(0, READ_LIMIT)}\n... [file truncated]` : content,
        error: null,
        meta: { path: args.path, bytes: content.length },
      };
    } catch (e) {
      return { ok: false, output: "", error: describe(e) };
    }
  },
});

const fileWrite = defineTool({
  spec: {
    name: "file.write",
    title: "Write file",
    description:
      "Create or overwrite a UTF-8 text file. Parent directories are created automatically.",
    permission: "write",
    timeoutMs: 2_000,
    cost: 0,
    parameters: {
      path: { type: "string", description: "Workspace path to write", required: true },
      content: { type: "string", description: "Full file contents", required: true },
    },
  },
  schema: z.object({
    path: pathSchema,
    content: z.string().max(400_000, "content exceeds the single-file limit"),
  }),
  async execute(args, ctx) {
    try {
      const change = ctx.vfs.write(args.path, args.content);
      return {
        ok: true,
        output: `${change.kind} ${change.path} (${fmtBytes(change.bytes)})`,
        error: null,
        meta: { path: change.path, kind: change.kind, bytes: change.bytes },
      };
    } catch (e) {
      return { ok: false, output: "", error: describe(e) };
    }
  },
});

const fileList = defineTool({
  spec: {
    name: "file.list",
    title: "List files",
    description: "List the contents of a workspace directory, or the whole tree recursively.",
    permission: "read",
    timeoutMs: 2_000,
    cost: 0,
    parameters: {
      path: { type: "string", description: "Directory path (defaults to /)", required: false },
      recursive: { type: "boolean", description: "Walk the whole subtree", required: false },
    },
  },
  schema: z.object({
    path: pathSchema.optional(),
    recursive: z.boolean().optional(),
  }),
  async execute(args, ctx) {
    try {
      const root = args.path ?? "/";
      if (args.recursive) {
        const files = ctx.vfs.walk(root);
        return {
          ok: true,
          output: files.length ? files.join("\n") : "(empty)",
          error: null,
          meta: { count: files.length },
        };
      }
      const entries = ctx.vfs.list(root);
      return {
        ok: true,
        output: entries.length
          ? entries.map((e) => (e.type === "dir" ? `${e.name}/` : `${e.name}  ${fmtBytes(e.bytes)}`)).join("\n")
          : "(empty)",
        error: null,
        meta: { count: entries.length },
      };
    } catch (e) {
      return { ok: false, output: "", error: describe(e) };
    }
  },
});

const fileDelete = defineTool({
  spec: {
    name: "file.delete",
    title: "Delete file",
    description: "Delete a file, or a directory when recursive is set.",
    permission: "write",
    timeoutMs: 2_000,
    cost: 0,
    parameters: {
      path: { type: "string", description: "Path to remove", required: true },
      recursive: { type: "boolean", description: "Remove directories too", required: false },
    },
  },
  schema: z.object({ path: pathSchema, recursive: z.boolean().optional() }),
  async execute(args, ctx) {
    try {
      const n = ctx.vfs.remove(args.path, "/", args.recursive ?? false);
      return { ok: true, output: `removed ${n} file(s)`, error: null, meta: { removed: n } };
    } catch (e) {
      return { ok: false, output: "", error: describe(e) };
    }
  },
});

export const fileTools = [fileRead, fileWrite, fileList, fileDelete];

function describe(e: unknown): string {
  if (e instanceof VfsError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
