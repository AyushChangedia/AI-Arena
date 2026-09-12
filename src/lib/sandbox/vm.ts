/**
 * Code executor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY NOTE — read this before believing anything about isolation.
 *
 * `NodeVmExecutor` runs JavaScript through `node:vm` in a context created from
 * a bare object. That context has NO `require`, NO `process`, NO `fs`, NO
 * network, NO timers, and no reference to the host global. The entire module
 * graph is executed inside a single `vm.runInContext` call so V8's wall-clock
 * watchdog covers all of it — verified to terminate infinite loops nested
 * inside dynamically constructed functions and across host callbacks.
 *
 * That is a RESTRICTION LAYER. It is NOT an isolation boundary. `node:vm`
 * shares a process with the host, and escapes via shared intrinsics are a
 * known, documented class of attack. It is appropriate for the arena's own
 * task code and for agent code under a cooperative threat model. Running
 * genuinely hostile code requires out-of-process isolation — a container, a
 * microVM, or a separate V8 isolate.
 *
 * `CodeExecutor` is the seam for exactly that swap: implement it against your
 * isolation mechanism of choice and register it instead. Nothing else changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import vm from "node:vm";
import type { Vfs } from "./vfs";
import { normalisePath } from "./vfs";

export interface CodeRunRequest {
  /** Absolute VFS path of the entry module. */
  entry: string;
  timeoutMs: number;
  /** Exposed to modules as `ARENA_INPUT`. Must be JSON-clonable. */
  input?: unknown;
  maxOutputChars?: number;
}

export interface CodeEvalRequest {
  /** Expression evaluated with `require(...)` and `ARENA_INPUT` in scope. */
  expression: string;
  timeoutMs: number;
  input?: unknown;
  maxOutputChars?: number;
}

export interface CodeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The resulting value, if JSON-serialisable. */
  value: unknown;
  error: { name: string; message: string } | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface CodeExecutor {
  readonly id: string;
  readonly available: boolean;
  /** Human-readable reason when `available` is false. Shown in the UI verbatim. */
  readonly unavailableReason: string | null;
  /** Execute a module from the workspace. */
  run(vfs: Vfs, req: CodeRunRequest): CodeRunResult;
  /** Evaluate an expression against the workspace. Used by the test grader. */
  evaluate(vfs: Vfs, req: CodeEvalRequest): CodeRunResult;
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_BUNDLE_BYTES = 600_000;

// ─── disabled implementation ────────────────────────────────────────────────

export class SandboxDisabledExecutor implements CodeExecutor {
  readonly id = "disabled";
  readonly available = false;
  readonly unavailableReason =
    "Code execution is disabled (ARENA_ENABLE_VM_SANDBOX=0). No code was run.";

  private refuse(): CodeRunResult {
    return {
      ok: false,
      stdout: "",
      stderr: this.unavailableReason,
      value: null,
      error: { name: "SandboxDisabled", message: this.unavailableReason },
      durationMs: 0,
      timedOut: false,
      truncated: false,
    };
  }

  run(): CodeRunResult {
    return this.refuse();
  }
  evaluate(): CodeRunResult {
    return this.refuse();
  }
}

// ─── node:vm implementation ─────────────────────────────────────────────────

export class NodeVmExecutor implements CodeExecutor {
  readonly id = "node-vm";
  readonly available = true;
  readonly unavailableReason = null;

  run(vfs: Vfs, req: CodeRunRequest): CodeRunResult {
    let entry: string;
    try {
      entry = normalisePath(req.entry);
    } catch (e) {
      return failure(`invalid entry path: ${(e as Error).message}`, "EINVAL");
    }
    return this.exec(vfs, {
      body: `return __require(${JSON.stringify(entry)}, "/");`,
      timeoutMs: req.timeoutMs,
      input: req.input,
      maxOutputChars: req.maxOutputChars,
    });
  }

  evaluate(vfs: Vfs, req: CodeEvalRequest): CodeRunResult {
    return this.exec(vfs, {
      body: `return (${req.expression});`,
      timeoutMs: req.timeoutMs,
      input: req.input,
      maxOutputChars: req.maxOutputChars,
    });
  }

  private exec(
    vfs: Vfs,
    opts: { body: string; timeoutMs: number; input?: unknown; maxOutputChars?: number },
  ): CodeRunResult {
    const started = Date.now();
    const limit = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;

    // Two tables. `sources` is what `require()` can load — JS and JSON only, so
    // a stray .html artifact is never executed. `files` is what `readFile()` can
    // read: the whole workspace, read-only. Sandboxed code cannot write to the
    // VFS; the agent does that through the file.write tool, which keeps change
    // tracking and the artifact record honest.
    const sources: Record<string, string> = {};
    const files: Record<string, string> = {};
    let bundleBytes = 0;
    for (const file of vfs.entries()) {
      bundleBytes += file.bytes;
      if (bundleBytes > MAX_BUNDLE_BYTES) {
        return failure(
          `workspace exceeds the ${MAX_BUNDLE_BYTES} byte sandbox limit`,
          "ELIMIT",
        );
      }
      files[file.path] = file.content;
      if (/\.(js|json|mjs|cjs)$/.test(file.path)) sources[file.path] = file.content;
    }

    const out: string[] = [];
    const err: string[] = [];
    let chars = 0;
    let truncated = false;

    const sink = (buf: string[]) => (...args: unknown[]) => {
      if (truncated) return;
      const line = args.map(render).join(" ");
      if (chars + line.length > limit) {
        truncated = true;
        buf.push("... output truncated at the sandbox limit");
        return;
      }
      chars += line.length + 1;
      buf.push(line);
    };

    const consoleShim = {
      log: sink(out),
      info: sink(out),
      debug: sink(out),
      warn: sink(err),
      error: sink(err),
      trace: sink(err),
    };

    const context = vm.createContext(
      { console: consoleShim },
      { name: "arena-sandbox", codeGeneration: { strings: true, wasm: false } },
    );

    let value: unknown = null;
    let error: CodeRunResult["error"] = null;
    let timedOut = false;

    try {
      const script = buildScript(sources, files, opts.body, opts.input);
      const raw: unknown = vm.runInContext(script, context, {
        timeout: Math.max(1, Math.min(opts.timeoutMs, 30_000)),
        displayErrors: true,
        filename: "arena:sandbox",
      });
      value = safeSerialise(raw);
    } catch (e) {
      const ex = e as Error;
      const message = ex?.message ?? String(e);
      timedOut = /timed out|terminated/i.test(message);
      error = {
        name: timedOut ? "TimeoutError" : (ex?.name ?? "Error"),
        message: timedOut
          ? `Execution exceeded the ${opts.timeoutMs}ms sandbox timeout and was terminated.`
          : message,
      };
    }

    return {
      ok: error === null,
      stdout: out.join("\n"),
      stderr: err.join("\n") || (error ? `${error.name}: ${error.message}` : ""),
      value,
      error,
      durationMs: Date.now() - started,
      timedOut,
      truncated,
    };
  }
}

/**
 * Builds one self-contained script: a module table, a CommonJS-shaped resolver
 * that only ever looks inside that table, and the caller's body. Everything
 * runs under a single V8 timeout.
 */
function buildScript(
  sources: Record<string, string>,
  files: Record<string, string>,
  body: string,
  input: unknown,
): string {
  const inputLiteral = input === undefined ? "undefined" : JSON.stringify(input) || "undefined";
  return `(function () {
  "use strict";
  var __sources = ${JSON.stringify(sources)};
  var __files = ${JSON.stringify(files)};
  var __cache = Object.create(null);
  var __loading = Object.create(null);
  var ARENA_INPUT = ${inputLiteral};

  function __normalise(spec, base) {
    var raw = spec.charAt(0) === "/" ? spec : base + "/" + spec;
    var parts = raw.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === "" || s === ".") continue;
      if (s === "..") { if (!out.length) throw new Error("path escapes the workspace root: " + spec); out.pop(); continue; }
      out.push(s);
    }
    return "/" + out.join("/");
  }

  function __resolve(spec, base) {
    var p = __normalise(spec, base);
    var candidates = [p, p + ".js", p + ".json", p + "/index.js"];
    for (var i = 0; i < candidates.length; i++) {
      if (Object.prototype.hasOwnProperty.call(__sources, candidates[i])) return candidates[i];
    }
    throw new Error("Cannot find module '" + spec + "'. The sandbox has no package registry; only files inside the workspace resolve.");
  }

  function __require(spec, base) {
    if (typeof spec !== "string") throw new TypeError("require() expects a string");
    var id = __resolve(spec, base || "/");
    if (__cache[id]) return __cache[id].exports;
    var dir = id.slice(0, id.lastIndexOf("/")) || "/";
    var mod = { exports: {} };
    __cache[id] = mod;
    if (__loading[id]) return mod.exports;
    __loading[id] = true;

    if (/\\.json$/.test(id)) {
      mod.exports = JSON.parse(__sources[id]);
    } else {
      var fn;
      try {
        fn = Function("exports", "require", "module", "__filename", "__dirname", "ARENA_INPUT",
          "readFile", "listFiles", "fileExists",
          "//# sourceURL=" + id + "\\n" + __sources[id]);
      } catch (e) {
        throw new SyntaxError("Syntax error in " + id + ": " + e.message);
      }
      fn.call(mod.exports, mod.exports, function (s) { return __require(s, dir); }, mod, id, dir,
        ARENA_INPUT, readFile, listFiles, fileExists);
    }
    __loading[id] = false;
    return mod.exports;
  }

  var require = function (s) { return __require(s, "/"); };

  // Read-only workspace access. Writing is deliberately absent: the agent
  // writes through the file.write tool so every change is tracked and graded.
  function readFile(path) {
    if (typeof path !== "string") throw new TypeError("readFile() expects a string path");
    var p = __normalise(path, "/");
    if (!Object.prototype.hasOwnProperty.call(__files, p)) {
      var e = new Error("ENOENT: no such file: " + p);
      e.code = "ENOENT";
      throw e;
    }
    return __files[p];
  }
  function listFiles() { return Object.keys(__files).sort(); }
  function fileExists(path) {
    try { return Object.prototype.hasOwnProperty.call(__files, __normalise(path, "/")); }
    catch (e) { return false; }
  }

  ${body}
})()`;
}

function failure(message: string, name: string): CodeRunResult {
  return {
    ok: false,
    stdout: "",
    stderr: `${name}: ${message}`,
    value: null,
    error: { name, message },
    durationMs: 0,
    timedOut: false,
    truncated: false,
  };
}

function render(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v, replacer, 2) ?? String(v);
  } catch {
    return "[unserialisable]";
  }
}

function replacer(_k: string, value: unknown) {
  if (typeof value === "function") {
    return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
  }
  if (typeof value === "bigint") return `${value.toString()}n`;
  return value;
}

function safeSerialise(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  try {
    return JSON.parse(JSON.stringify(v, replacer)) as unknown;
  } catch {
    return null;
  }
}

let cached: CodeExecutor | null = null;

/** Chooses an executor from the environment. Never throws. */
export function createCodeExecutor(env: Record<string, string | undefined> = process.env): CodeExecutor {
  if (env.ARENA_ENABLE_VM_SANDBOX === "0") return new SandboxDisabledExecutor();
  return new NodeVmExecutor();
}

/** Process-wide executor. Stateless, so sharing one instance is safe. */
export function codeExecutor(): CodeExecutor {
  cached ??= createCodeExecutor();
  return cached;
}
