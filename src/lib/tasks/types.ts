import type { ExecutionEvent, Task } from "@/lib/arena/types";
import type { Vfs } from "@/lib/sandbox/vfs";
import type { CodeExecutor } from "@/lib/sandbox/vm";
import type { ShellHook } from "@/lib/sandbox/shell";
import type { PolicyProfile, ScriptedPolicy } from "@/lib/agents/policies/types";

/** Everything a grader is allowed to look at: the finished environment. */
export interface GradingContext {
  vfs: Vfs;
  executor: CodeExecutor;
  events: ExecutionEvent[];
  task: Task;
}

export interface TestOutcome {
  passed: boolean;
  message: string;
}

/** A real assertion. It reads the workspace and runs the agent's real code. */
export interface TaskTest {
  id: string;
  name: string;
  run(ctx: GradingContext): TestOutcome | Promise<TestOutcome>;
}

export interface RubricOutcome {
  passed: boolean;
  /** 0–1. Partial credit is allowed; `passed` is `score >= 1`. */
  score: number;
  message: string;
}

export interface RubricCheck {
  id: string;
  name: string;
  weight: number;
  run(ctx: GradingContext): RubricOutcome | Promise<RubricOutcome>;
}

export interface TaskDefinition {
  task: Task;
  /**
   * Builds the starting workspace. Must be a pure function of the seed: the
   * engine materialises it twice and asserts both sides hash identically.
   */
  environment(seed: string): Record<string, string>;
  /** Commands this task adds to the virtual shell, e.g. `npm test`. */
  shellHooks(executor: CodeExecutor): Record<string, ShellHook>;
  /** Authoritative assertions. These decide `tests.passRate`. */
  tests: TaskTest[];
  /** Deterministic qualitative checks. */
  rubric: RubricCheck[];
  /** The demo brain for this task. */
  policy(profile: PolicyProfile): ScriptedPolicy;
}

// ─── grader helpers ─────────────────────────────────────────────────────────

const EVAL_TIMEOUT = 4_000;

/**
 * Runs an expression against the agent's workspace and compares the result to
 * an expected value by structural equality.
 */
export function jsTest(
  id: string,
  name: string,
  expression: string,
  expected: unknown,
): TaskTest {
  return {
    id,
    name,
    run(ctx) {
      const r = ctx.executor.evaluate(ctx.vfs, { expression, timeoutMs: EVAL_TIMEOUT });
      if (!r.ok) {
        return {
          passed: false,
          message: `threw ${r.error?.name ?? "Error"}: ${trim(r.error?.message ?? "unknown error")}`,
        };
      }
      const actual = JSON.stringify(r.value);
      const want = JSON.stringify(expected ?? null);
      return actual === want
        ? { passed: true, message: `= ${trim(want, 80)}` }
        : { passed: false, message: `expected ${trim(want, 90)}, got ${trim(actual, 90)}` };
    },
  };
}

/** Asserts an expression evaluates truthy without throwing. */
export function jsTruthy(id: string, name: string, expression: string): TaskTest {
  return {
    id,
    name,
    run(ctx) {
      const r = ctx.executor.evaluate(ctx.vfs, { expression, timeoutMs: EVAL_TIMEOUT });
      if (!r.ok) {
        return {
          passed: false,
          message: `threw ${r.error?.name ?? "Error"}: ${trim(r.error?.message ?? "")}`,
        };
      }
      return r.value
        ? { passed: true, message: "ok" }
        : { passed: false, message: `expected truthy, got ${trim(JSON.stringify(r.value), 80)}` };
    },
  };
}

export function fileExistsCheck(id: string, name: string, path: string, weight = 1): RubricCheck {
  return {
    id,
    name,
    weight,
    run(ctx) {
      const exists = ctx.vfs.isFile(path);
      return {
        passed: exists,
        score: exists ? 1 : 0,
        message: exists ? `${path} present (${ctx.vfs.stat(path).bytes} bytes)` : `${path} was never created`,
      };
    },
  };
}

export function contentCheck(
  id: string,
  name: string,
  path: string,
  predicate: (content: string) => RubricOutcome,
  weight = 1,
): RubricCheck {
  return {
    id,
    name,
    weight,
    run(ctx) {
      if (!ctx.vfs.isFile(path)) {
        return { passed: false, score: 0, message: `${path} does not exist` };
      }
      try {
        return predicate(ctx.vfs.read(path));
      } catch (e) {
        return { passed: false, score: 0, message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** Graded partial credit: how many of a required set appear in the content. */
export function coverageCheck(
  id: string,
  name: string,
  path: string,
  required: { label: string; test: RegExp }[],
  weight = 1,
): RubricCheck {
  return contentCheck(
    id,
    name,
    path,
    (content) => {
      const hits = required.filter((r) => r.test.test(content));
      const missed = required.filter((r) => !r.test.test(content)).map((r) => r.label);
      const score = required.length === 0 ? 1 : hits.length / required.length;
      return {
        passed: score >= 1,
        score,
        message:
          missed.length === 0
            ? `all ${required.length} covered`
            : `${hits.length}/${required.length} covered — missing: ${missed.slice(0, 5).join(", ")}`,
      };
    },
    weight,
  );
}

export function trim(s: string, max = 160): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A shell hook that runs the workspace's own test files and reports results —
 * the `npm test` an agent invokes. Independent of the authoritative grader, so
 * an agent editing its test file changes this output but not its score.
 */
export function npmTestHook(testEntry: string): ShellHook {
  return (argv, ctx) => {
    const script = argv[1];
    if (script !== "test") {
      return {
        stdout: "",
        stderr: `npm: unknown script "${script ?? ""}". This task defines: test`,
        exitCode: 1,
        durationMs: 0,
      };
    }
    if (!ctx.executor.available) {
      return {
        stdout: "",
        stderr: ctx.executor.unavailableReason ?? "code execution unavailable",
        exitCode: 1,
        durationMs: 0,
      };
    }
    if (!ctx.vfs.isFile(testEntry)) {
      return {
        stdout: "",
        stderr: `npm test: ${testEntry} is missing. Restore it or write your own tests.`,
        exitCode: 1,
        durationMs: 0,
      };
    }

    const r = ctx.executor.evaluate(ctx.vfs, {
      timeoutMs: 8_000,
      expression: `(function () {
        var cases = require(${JSON.stringify(testEntry)});
        if (!Array.isArray(cases)) throw new Error("test file must export an array of { name, fn }");
        var out = [];
        for (var i = 0; i < cases.length; i++) {
          var c = cases[i];
          try { c.fn(); out.push({ name: c.name, passed: true, message: "" }); }
          catch (e) { out.push({ name: c.name, passed: false, message: String(e && e.message || e) }); }
        }
        return out;
      })()`,
    });

    if (!r.ok) {
      return {
        stdout: "",
        stderr: `npm test failed to run: ${r.error?.name}: ${r.error?.message}`,
        exitCode: 1,
        durationMs: r.durationMs,
      };
    }

    const results = (r.value ?? []) as { name: string; passed: boolean; message: string }[];
    const passed = results.filter((t) => t.passed).length;
    const lines = results.map((t) => (t.passed ? `  PASS  ${t.name}` : `  FAIL  ${t.name}\n        ${t.message}`));
    const summary = `\n${passed}/${results.length} passing`;

    return {
      stdout: `${lines.join("\n")}${summary}`,
      stderr: passed === results.length ? "" : `${results.length - passed} test(s) failing`,
      exitCode: passed === results.length ? 0 : 1,
      durationMs: r.durationMs,
    };
  };
}
