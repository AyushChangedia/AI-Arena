/**
 * Virtual shell.
 *
 * This is NOT a host shell. There is no `child_process` anywhere in this file
 * or in anything it imports. It is a small interpreter — tokeniser, pipeline
 * splitter, command table — running over the in-memory VFS. Commands that are
 * not in the table do not fall through to anything; they return "command not
 * found", the same way a real shell would, and the agent has to adapt.
 *
 * `node` routes to the VM code executor. `npm test` routes to whatever grader
 * the task registered. Both are real executions, not canned output.
 */

import type { Vfs } from "./vfs";
import { VfsError, fmtBytes } from "./vfs";
import type { CodeExecutor } from "./vm";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** A task-provided command, e.g. `npm test` running the grader. */
export type ShellHook = (argv: string[], ctx: ShellContext) => Promise<ShellResult> | ShellResult;

export interface ShellContext {
  vfs: Vfs;
  cwd: string;
  executor: CodeExecutor;
  timeoutMs: number;
}

export interface VirtualShellOptions {
  vfs: Vfs;
  executor: CodeExecutor;
  /** Extra commands, keyed by command name. Overrides built-ins. */
  hooks?: Record<string, ShellHook>;
  maxOutputChars?: number;
  timeoutMs?: number;
}

const MAX_OUTPUT = 16_000;

export const SHELL_COMMANDS = [
  "ls", "cat", "echo", "pwd", "cd", "mkdir", "touch", "rm", "cp", "mv",
  "grep", "find", "wc", "head", "tail", "node", "npm", "true", "false", "help",
] as const;

export class VirtualShell {
  private vfs: Vfs;
  private executor: CodeExecutor;
  private hooks: Record<string, ShellHook>;
  private maxOutput: number;
  private timeoutMs: number;
  cwd = "/";

  constructor(opts: VirtualShellOptions) {
    this.vfs = opts.vfs;
    this.executor = opts.executor;
    this.hooks = opts.hooks ?? {};
    this.maxOutput = opts.maxOutputChars ?? MAX_OUTPUT;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /** Run a command line. Never throws: shell errors come back as exitCode != 0. */
  async exec(line: string): Promise<ShellResult> {
    const started = Date.now();
    if (typeof line !== "string" || line.trim() === "") {
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
    }
    if (line.length > 4_000) {
      return fail("command line too long (4000 char limit)", started);
    }

    let out = "";
    let err = "";
    let code = 0;

    try {
      // `a && b` / `a ; b` sequencing, evaluated left to right.
      for (const { op, text } of splitSequence(line)) {
        if (op === "&&" && code !== 0) break;
        const r = await this.runPipeline(text);
        out += r.stdout ? (out ? "\n" : "") + r.stdout : "";
        err += r.stderr ? (err ? "\n" : "") + r.stderr : "";
        code = r.exitCode;
      }
    } catch (e) {
      return fail(describe(e), started);
    }

    return {
      stdout: clamp(out, this.maxOutput),
      stderr: clamp(err, this.maxOutput),
      exitCode: code,
      durationMs: Date.now() - started,
    };
  }

  private async runPipeline(segment: string): Promise<ShellResult> {
    const stages = splitPipes(segment);
    let piped = "";
    let result: ShellResult = { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const { argv, redirect } = parseRedirect(tokenise(stage));
      if (argv.length === 0) continue;

      result = await this.runCommand(argv, piped);

      if (redirect) {
        const target = redirect.path;
        try {
          if (redirect.append) this.vfs.append(target, result.stdout + "\n", this.cwd);
          else this.vfs.write(target, result.stdout ? `${result.stdout}\n` : "", this.cwd);
          result = { ...result, stdout: "" };
        } catch (e) {
          return { stdout: "", stderr: describe(e), exitCode: 1, durationMs: result.durationMs };
        }
      }
      piped = result.stdout;
      if (result.exitCode !== 0 && i < stages.length - 1) break;
    }
    return result;
  }

  private async runCommand(argv: string[], stdin: string): Promise<ShellResult> {
    const started = Date.now();
    const [cmd, ...args] = argv as [string, ...string[]];

    const hook = this.hooks[cmd];
    if (hook) {
      try {
        return await hook(argv, {
          vfs: this.vfs,
          cwd: this.cwd,
          executor: this.executor,
          timeoutMs: this.timeoutMs,
        });
      } catch (e) {
        return fail(describe(e), started);
      }
    }

    try {
      switch (cmd) {
        case "true":
          return ok("", started);
        case "false":
          return { stdout: "", stderr: "", exitCode: 1, durationMs: Date.now() - started };
        case "help":
          return ok(
            `available commands: ${[...SHELL_COMMANDS, ...Object.keys(this.hooks)].sort().join(" ")}\n` +
              `supports: quoting, pipes (|), redirects (> >>), sequencing (&& ;)`,
            started,
          );
        case "pwd":
          return ok(this.cwd, started);
        case "cd": {
          const target = args[0] ?? "/";
          if (!this.vfs.isDir(target, this.cwd)) {
            return fail(`cd: not a directory: ${target}`, started);
          }
          this.cwd = this.vfs.isDir(target, this.cwd)
            ? normaliseAgainst(target, this.cwd)
            : this.cwd;
          return ok("", started);
        }
        case "echo": {
          const noNewline = args[0] === "-n";
          const text = (noNewline ? args.slice(1) : args).join(" ");
          return ok(text, started);
        }
        case "ls": {
          const longForm = args.includes("-l") || args.includes("-la") || args.includes("-al");
          const paths = args.filter((a) => !a.startsWith("-"));
          const target = paths[0] ?? ".";
          const entries = this.vfs.list(target, this.cwd);
          if (entries.length === 0) return ok("", started);
          return ok(
            longForm
              ? entries
                  .map(
                    (e) =>
                      `${e.type === "dir" ? "d" : "-"}  ${String(e.type === "dir" ? "-" : fmtBytes(e.bytes)).padStart(8)}  ${e.name}${e.type === "dir" ? "/" : ""}`,
                  )
                  .join("\n")
              : entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)).join("\n"),
            started,
          );
        }
        case "cat": {
          if (args.length === 0) return ok(stdin, started);
          const parts: string[] = [];
          for (const p of args) parts.push(this.vfs.read(p, this.cwd));
          return ok(parts.join("\n"), started);
        }
        case "mkdir": {
          const paths = args.filter((a) => !a.startsWith("-"));
          if (paths.length === 0) return fail("mkdir: missing operand", started);
          for (const p of paths) this.vfs.mkdirp(p, this.cwd);
          return ok("", started);
        }
        case "touch": {
          for (const p of args) if (!this.vfs.isFile(p, this.cwd)) this.vfs.write(p, "", this.cwd);
          return ok("", started);
        }
        case "rm": {
          const recursive = args.some((a) => /^-[rf]*r[rf]*$/.test(a));
          const paths = args.filter((a) => !a.startsWith("-"));
          if (paths.length === 0) return fail("rm: missing operand", started);
          let n = 0;
          for (const p of paths) n += this.vfs.remove(p, this.cwd, recursive);
          return ok(`removed ${n} file${n === 1 ? "" : "s"}`, started);
        }
        case "cp": {
          const [from, to] = args;
          if (!from || !to) return fail("cp: usage: cp <source> <dest>", started);
          this.vfs.copy(from, to, this.cwd);
          return ok("", started);
        }
        case "mv": {
          const [from, to] = args;
          if (!from || !to) return fail("mv: usage: mv <source> <dest>", started);
          this.vfs.move(from, to, this.cwd);
          return ok("", started);
        }
        case "wc": {
          const countLines = args.includes("-l");
          const paths = args.filter((a) => !a.startsWith("-"));
          const text = paths.length ? paths.map((p) => this.vfs.read(p, this.cwd)).join("\n") : stdin;
          const lines = text === "" ? 0 : text.split("\n").length;
          const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
          return ok(countLines ? String(lines) : `${lines} ${words} ${text.length}`, started);
        }
        case "head":
        case "tail": {
          const nFlag = args.findIndex((a) => a === "-n");
          const n = nFlag >= 0 ? Number(args[nFlag + 1] ?? 10) : 10;
          const paths = args.filter((a, i) => !a.startsWith("-") && i !== nFlag + 1);
          const text = paths.length ? paths.map((p) => this.vfs.read(p, this.cwd)).join("\n") : stdin;
          const lines = text.split("\n");
          const count = Number.isFinite(n) ? Math.max(0, n) : 10;
          return ok((cmd === "head" ? lines.slice(0, count) : lines.slice(-count)).join("\n"), started);
        }
        case "grep": {
          const flags = args.filter((a) => a.startsWith("-"));
          const rest = args.filter((a) => !a.startsWith("-"));
          const [pattern, ...paths] = rest;
          if (!pattern) return fail("grep: usage: grep [-in] <pattern> [file...]", started);
          let re: RegExp;
          try {
            re = new RegExp(pattern, flags.some((f) => f.includes("i")) ? "i" : "");
          } catch {
            return fail(`grep: invalid pattern: ${pattern}`, started);
          }
          const showLineNumbers = flags.some((f) => f.includes("n"));
          const hits: string[] = [];
          const scan = (label: string | null, text: string) => {
            text.split("\n").forEach((line, i) => {
              if (!re.test(line)) return;
              const prefix = [label, showLineNumbers ? String(i + 1) : null].filter(Boolean).join(":");
              hits.push(prefix ? `${prefix}:${line}` : line);
            });
          };
          if (paths.length === 0) scan(null, stdin);
          else
            for (const p of paths) {
              const isDir = this.vfs.isDir(p, this.cwd);
              const targets = isDir ? this.vfs.walk(p, this.cwd) : [p];
              for (const t of targets) scan(paths.length > 1 || isDir ? t : null, this.vfs.read(t, this.cwd));
            }
          return hits.length
            ? ok(hits.join("\n"), started)
            : { stdout: "", stderr: "", exitCode: 1, durationMs: Date.now() - started };
        }
        case "find": {
          const root = args.find((a) => !a.startsWith("-")) ?? ".";
          const nameFlag = args.indexOf("-name");
          const pattern = nameFlag >= 0 ? args[nameFlag + 1] : undefined;
          let files = this.vfs.walk(root, this.cwd);
          if (pattern) {
            const re = globToRegExp(pattern);
            files = files.filter((f) => re.test(f.slice(f.lastIndexOf("/") + 1)));
          }
          return ok(files.join("\n"), started);
        }
        case "node": {
          const file = args.find((a) => !a.startsWith("-"));
          if (!file) return fail("node: no entry file given", started);
          if (!this.executor.available) {
            return fail(`node: ${this.executor.unavailableReason ?? "code execution unavailable"}`, started);
          }
          const r = this.executor.run(this.vfs, {
            entry: normaliseAgainst(file, this.cwd),
            timeoutMs: this.timeoutMs,
          });
          return {
            stdout: clamp(r.stdout, this.maxOutput),
            stderr: clamp(r.ok ? r.stderr : `${r.error?.name}: ${r.error?.message}`, this.maxOutput),
            exitCode: r.ok ? 0 : 1,
            durationMs: r.durationMs,
          };
        }
        case "npm": {
          // Only reachable when the task did not register an `npm` hook.
          return fail(
            `npm: this task registers no npm scripts. The sandbox has no package registry.`,
            started,
          );
        }
        default:
          return fail(
            `${cmd}: command not found. available: ${[...SHELL_COMMANDS, ...Object.keys(this.hooks)].sort().join(" ")}`,
            started,
            127,
          );
      }
    } catch (e) {
      return fail(`${cmd}: ${describe(e)}`, started);
    }
  }
}

// ─── parsing ────────────────────────────────────────────────────────────────

/** Tokenise with single/double quote support and backslash escapes. */
export function tokenise(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      current += input[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (current || has) tokens.push(current);
      current = "";
      has = false;
      continue;
    }
    current += c;
    has = true;
  }
  if (current || has) tokens.push(current);
  return tokens;
}

function splitSequence(line: string): { op: "&&" | ";" | null; text: string }[] {
  const out: { op: "&&" | ";" | null; text: string }[] = [];
  let buf = "";
  let quote: string | null = null;
  let op: "&&" | ";" | null = null;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "&" && line[i + 1] === "&") {
      out.push({ op, text: buf });
      buf = "";
      op = "&&";
      i++;
      continue;
    }
    if (c === ";") {
      out.push({ op, text: buf });
      buf = "";
      op = ";";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push({ op, text: buf });
  return out.filter((s) => s.text.trim() !== "");
}

function splitPipes(segment: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "|") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.filter((s) => s.trim() !== "");
}

function parseRedirect(tokens: string[]): {
  argv: string[];
  redirect: { path: string; append: boolean } | null;
} {
  const argv: string[] = [];
  let redirect: { path: string; append: boolean } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === ">" || t === ">>") {
      const path = tokens[i + 1];
      if (path) redirect = { path, append: t === ">>" };
      i++;
      continue;
    }
    if (t.startsWith(">>") && t.length > 2) {
      redirect = { path: t.slice(2), append: true };
      continue;
    }
    if (t.startsWith(">") && t.length > 1) {
      redirect = { path: t.slice(1), append: false };
      continue;
    }
    argv.push(t);
  }
  return { argv, redirect };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normaliseAgainst(path: string, cwd: string): string {
  const raw = path.startsWith("/") ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const s of raw.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") {
      out.pop();
      continue;
    }
    out.push(s);
  }
  return `/${out.join("/")}`;
}

function ok(stdout: string, started: number): ShellResult {
  return { stdout, stderr: "", exitCode: 0, durationMs: Date.now() - started };
}

function fail(stderr: string, started: number, exitCode = 1): ShellResult {
  return { stdout: "", stderr, exitCode, durationMs: Date.now() - started };
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n... output truncated at ${max} characters`;
}

function describe(e: unknown): string {
  if (e instanceof VfsError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
