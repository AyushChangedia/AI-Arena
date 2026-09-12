import type { GradingContext, TaskDefinition, TaskTest } from "../types";
import { contentCheck, fileExistsCheck } from "../types";
import type { PolicyAction, PolicyContext, PolicyProfile, ScriptedPolicy } from "@/lib/agents/policies/types";
import { countOf, lastFor } from "@/lib/agents/policies/types";
import { extractJsonObject } from "../util";

/**
 * SCHEDULE THE ON-CALL ROTATION
 *
 * A constraint satisfaction problem with 2,272 valid solutions and a very large
 * space of invalid ones. There is no answer key: every constraint is verified
 * programmatically against whatever the agent produced, so any valid schedule
 * scores full marks and no invalid one can slip through.
 */

const TARGET = "/schedule.json";
const PEOPLE = ["ana", "bo", "cy", "dee", "eli", "fin"] as const;
const WEEKS = 4;

const SPEC = `# On-call rotation — Q1

Six engineers, four weeks, two people on call each week.

    ana  bo  cy  dee  eli  fin

Produce \`schedule.json\`:

    {
      "weeks": [
        { "week": 1, "primary": "<name>", "secondary": "<name>" },
        { "week": 2, "primary": "<name>", "secondary": "<name>" },
        { "week": 3, "primary": "<name>", "secondary": "<name>" },
        { "week": 4, "primary": "<name>", "secondary": "<name>" }
      ]
    }

## Constraints

1. Exactly four weeks, numbered 1 to 4 in order.
2. Each week has one primary and one secondary, and they are different people.
3. Only the six named engineers appear. Names are lowercase, exactly as above.
4. **No one serves in consecutive weeks**, in either role.
5. **No one serves more than twice** across the quarter.
6. **Everyone serves at least once.**
7. **dee is unavailable in weeks 2 and 3** (parental leave).
8. **cy is new** and may only be secondary, never primary.
9. **ana and fin must not be on call in the same week** — they are the only two
   who know the payments service, and we will not have both unavailable at once.
10. **No pair may work together twice.**

A valid schedule exists. More than one does; any valid one is correct.
`;

interface Week {
  week: number;
  primary: string;
  secondary: string;
}

function readSchedule(ctx: GradingContext): { weeks: Week[] } | { error: string } {
  if (!ctx.vfs.isFile(TARGET)) return { error: `${TARGET} was never created` };
  let doc: unknown;
  try {
    doc = JSON.parse(ctx.vfs.read(TARGET));
  } catch (e) {
    return { error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const weeks = (doc as { weeks?: unknown })?.weeks;
  if (!Array.isArray(weeks)) return { error: "missing a `weeks` array" };
  const parsed: Week[] = [];
  for (const w of weeks) {
    const row = w as Record<string, unknown>;
    if (typeof row?.week !== "number" || typeof row?.primary !== "string" || typeof row?.secondary !== "string") {
      return { error: "each week needs numeric `week` and string `primary` and `secondary`" };
    }
    parsed.push({ week: row.week, primary: row.primary, secondary: row.secondary });
  }
  return { weeks: parsed };
}

function constraintTest(
  id: string,
  name: string,
  check: (weeks: Week[]) => { passed: boolean; message: string },
): TaskTest {
  return {
    id,
    name,
    run(ctx) {
      const doc = readSchedule(ctx);
      if ("error" in doc) return { passed: false, message: doc.error };
      return check(doc.weeks);
    },
  };
}

const slotsOf = (w: Week) => [w.primary, w.secondary];

export const oncallRotation: TaskDefinition = {
  task: {
    id: "task_oncall_rotation",
    slug: "oncall-rotation",
    title: "Schedule the on-call rotation",
    brief: "Ten constraints, four weeks, six engineers. Every constraint is machine-verified.",
    prompt: `Read /SPEC.md and produce ${TARGET}: a four-week on-call rotation for six engineers
satisfying all ten constraints.

There is no answer key. Every constraint is checked programmatically against whatever you
produce, so any valid schedule earns full marks — and none of them can be argued around.

The three that catch people: dee is out in weeks 2 and 3, cy can never be primary, and no
pair may work together twice. Nobody serves in consecutive weeks, and everybody serves.

You have code.run. Verifying your own schedule against the constraints before you submit is
worth more than reasoning carefully once.`,
    category: "reasoning",
    difficulty: "hard",
    limits: { timeLimitMs: 150_000, stepLimit: 24, budgetUsd: 0.5 },
    toolsAllowed: ["file.read", "file.write", "file.list", "code.run", "shell.exec"],
    successConditions: [
      "schedule.json parses with four ordered weeks",
      "All ten constraints hold",
      "Every engineer appears at least once and nobody more than twice",
    ],
    evaluation: {
      evaluators: ["tests", "rubric", "trace"],
      weights: {
        "tests.passRate": 0.6,
        "rubric.score": 0.1,
        "efficiency.score": 0.15,
        "resilience.score": 0.1,
        "cost.usd": 0.05,
      },
      weightsOverridden: true,
    },
    seedFiles: [{ path: "/SPEC.md", content: SPEC, note: "The roster and all ten constraints" }],
    targetArtifact: { path: TARGET, kind: "json" },
  },

  environment() {
    return { "/SPEC.md": SPEC };
  },

  shellHooks() {
    return {};
  },

  tests: [
    constraintTest("shape", "four weeks, numbered 1 to 4 in order", (weeks) => {
      if (weeks.length !== WEEKS) return { passed: false, message: `expected 4 weeks, got ${weeks.length}` };
      const numbers = weeks.map((w) => w.week);
      const ok = numbers.every((n, i) => n === i + 1);
      return { passed: ok, message: ok ? "ok" : `week numbers were ${numbers.join(", ")}` };
    }),
    constraintTest("known-people", "only the six named engineers appear", (weeks) => {
      const unknown = weeks
        .flatMap(slotsOf)
        .filter((p) => !(PEOPLE as readonly string[]).includes(p));
      return {
        passed: unknown.length === 0,
        message: unknown.length === 0 ? "ok" : `unknown: ${[...new Set(unknown)].join(", ")}`,
      };
    }),
    constraintTest("distinct-roles", "primary and secondary differ each week", (weeks) => {
      const bad = weeks.filter((w) => w.primary === w.secondary).map((w) => w.week);
      return { passed: bad.length === 0, message: bad.length === 0 ? "ok" : `week(s) ${bad.join(", ")}` };
    }),
    constraintTest("no-consecutive", "nobody serves in consecutive weeks", (weeks) => {
      const clashes: string[] = [];
      for (let i = 0; i < weeks.length - 1; i++) {
        const a = new Set(slotsOf(weeks[i]!));
        for (const p of slotsOf(weeks[i + 1]!)) {
          if (a.has(p)) clashes.push(`${p} in weeks ${weeks[i]!.week} and ${weeks[i + 1]!.week}`);
        }
      }
      return { passed: clashes.length === 0, message: clashes.length === 0 ? "ok" : clashes.join("; ") };
    }),
    constraintTest("max-two", "nobody serves more than twice", (weeks) => {
      const counts = new Map<string, number>();
      for (const p of weeks.flatMap(slotsOf)) counts.set(p, (counts.get(p) ?? 0) + 1);
      const over = [...counts.entries()].filter(([, n]) => n > 2);
      return {
        passed: over.length === 0,
        message: over.length === 0 ? "ok" : over.map(([p, n]) => `${p} serves ${n}x`).join(", "),
      };
    }),
    constraintTest("everyone-serves", "everyone serves at least once", (weeks) => {
      const served = new Set(weeks.flatMap(slotsOf));
      const missing = PEOPLE.filter((p) => !served.has(p));
      return { passed: missing.length === 0, message: missing.length === 0 ? "ok" : `never on call: ${missing.join(", ")}` };
    }),
    constraintTest("dee-unavailable", "dee is not scheduled in weeks 2 or 3", (weeks) => {
      const bad = weeks.filter((w) => (w.week === 2 || w.week === 3) && slotsOf(w).includes("dee"));
      return { passed: bad.length === 0, message: bad.length === 0 ? "ok" : `dee is on call in week ${bad.map((w) => w.week).join(", ")}` };
    }),
    constraintTest("cy-secondary-only", "cy is never primary", (weeks) => {
      const bad = weeks.filter((w) => w.primary === "cy").map((w) => w.week);
      return { passed: bad.length === 0, message: bad.length === 0 ? "ok" : `cy is primary in week ${bad.join(", ")}` };
    }),
    constraintTest("ana-fin-split", "ana and fin are never on call together", (weeks) => {
      const bad = weeks
        .filter((w) => slotsOf(w).includes("ana") && slotsOf(w).includes("fin"))
        .map((w) => w.week);
      return { passed: bad.length === 0, message: bad.length === 0 ? "ok" : `paired in week ${bad.join(", ")}` };
    }),
    constraintTest("no-repeat-pairs", "no pair works together twice", (weeks) => {
      const seen = new Map<string, number>();
      const repeats: string[] = [];
      for (const w of weeks) {
        const key = [...slotsOf(w)].sort().join("+");
        if (seen.has(key)) repeats.push(`${key} in weeks ${seen.get(key)} and ${w.week}`);
        else seen.set(key, w.week);
      }
      return { passed: repeats.length === 0, message: repeats.length === 0 ? "ok" : repeats.join("; ") };
    }),
  ],

  rubric: [
    fileExistsCheck("artifact", "the schedule exists", TARGET, 1),
    contentCheck(
      "clean-json",
      "the output is a clean JSON object with no extra commentary",
      TARGET,
      (content) => {
        try {
          JSON.parse(content);
          return { passed: true, score: 1, message: "parses cleanly" };
        } catch {
          return { passed: false, score: 0, message: "not parseable as JSON" };
        }
      },
      1,
    ),
    {
      id: "self-verified",
      name: "verified the schedule against the constraints before submitting",
      weight: 2,
      run(ctx: GradingContext) {
        const verified = ctx.events.some(
          (e) => e.tool === "code.run" && e.status === "ok" && e.type === "agent.tool_completed",
        );
        return {
          passed: verified,
          score: verified ? 1 : 0,
          message: verified
            ? "ran a constraint check in the sandbox"
            : "submitted without executing a check",
        };
      },
    },
  ],

  policy(profile: PolicyProfile): ScriptedPolicy {
    return new RotationPolicy(profile);
  },
};

// ─── demo policy ────────────────────────────────────────────────────────────

/**
 * A real solver, run inside the sandbox. The demo agent does not paste a
 * memorised answer: it searches the space and prints whatever it finds, and the
 * grader independently verifies that.
 */
const SOLVER = `// Exhaustive search over the 4-week rotation.
var PEOPLE = ${JSON.stringify(PEOPLE)};

function pairsFor(week) {
  var out = [];
  for (var i = 0; i < PEOPLE.length; i++) {
    for (var j = 0; j < PEOPLE.length; j++) {
      var p = PEOPLE[i], s = PEOPLE[j];
      if (p === s) continue;
      if (p === "cy") continue;                                  // cy: secondary only
      if ((p === "dee" || s === "dee") && (week === 2 || week === 3)) continue;
      var both = (p === "ana" || s === "ana") && (p === "fin" || s === "fin");
      if (both) continue;                                        // ana + fin never together
      out.push([p, s]);
    }
  }
  return out;
}

var options = [pairsFor(1), pairsFor(2), pairsFor(3), pairsFor(4)];
var answer = null;

function overlaps(a, b) { return a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1]; }

function search(week, chosen) {
  if (answer) return;
  if (week === 4) {
    var counts = {};
    var pairKeys = {};
    for (var i = 0; i < chosen.length; i++) {
      var c = chosen[i];
      counts[c[0]] = (counts[c[0]] || 0) + 1;
      counts[c[1]] = (counts[c[1]] || 0) + 1;
      var key = [c[0], c[1]].sort().join("+");
      if (pairKeys[key]) return;                                 // no repeated pairing
      pairKeys[key] = true;
    }
    for (var k in counts) if (counts[k] > 2) return;             // at most twice
    for (var n = 0; n < PEOPLE.length; n++) if (!counts[PEOPLE[n]]) return;  // everyone serves
    answer = chosen.slice();
    return;
  }
  var candidates = options[week];
  for (var c2 = 0; c2 < candidates.length; c2++) {
    var next = candidates[c2];
    if (week > 0 && overlaps(chosen[week - 1], next)) continue;  // no consecutive weeks
    chosen.push(next);
    search(week + 1, chosen);
    chosen.pop();
    if (answer) return;
  }
}

search(0, []);

if (!answer) throw new Error("no schedule satisfies the constraints");

var schedule = {
  weeks: answer.map(function (pair, i) {
    return { week: i + 1, primary: pair[0], secondary: pair[1] };
  }),
};

console.log(JSON.stringify(schedule, null, 2));
module.exports = schedule;
`;

/** Reasons it out in one pass and misses the no-consecutive-weeks rule. */
const GUESS = JSON.stringify(
  {
    weeks: [
      { week: 1, primary: "ana", secondary: "bo" },
      { week: 2, primary: "bo", secondary: "cy" },
      { week: 3, primary: "eli", secondary: "fin" },
      { week: 4, primary: "dee", secondary: "cy" },
    ],
  },
  null,
  2,
);

class RotationPolicy implements ScriptedPolicy {
  readonly id = "oncall-rotation";
  readonly describe =
    "The careful profile writes a solver and runs it; the reactive profile reasons it out in " +
    "one pass and submits a schedule that violates the consecutive-weeks rule.";

  constructor(private profile: PolicyProfile) {}

  next(ctx: PolicyContext): PolicyAction {
    const { history, profile } = ctx;
    const reads = countOf(history, "file.read");
    const runs = history.filter((h) => h.tool === "code.run");
    const writes = history.filter((h) => h.tool === "file.write" && h.args.path === TARGET);

    if (reads === 0) {
      return {
        kind: "tool",
        think: "Read the constraints. Ten of them interact, so precision matters more than speed.",
        tool: "file.read",
        args: { path: "/SPEC.md" },
      };
    }

    if (!profile.careful && writes.length === 0) {
      return {
        kind: "tool",
        think:
          "Six people over four weeks. Rotate through them and keep dee out of the middle two.",
        tool: "file.write",
        args: { path: TARGET, content: GUESS },
      };
    }

    if (profile.explore >= 2 && countOf(history, "file.list") === 0) {
      return {
        kind: "tool",
        think: "Survey the workspace before committing to an approach.",
        tool: "file.list",
        args: { path: "/", recursive: true },
      };
    }

    if (profile.careful && runs.length === 0) {
      return {
        kind: "tool",
        think:
          "Ten interacting constraints is a search problem, not a reasoning problem. " +
          "Write a solver and let it prove the answer.",
        tool: "code.run",
        args: { saveAs: "/src/solve.js", source: SOLVER },
      };
    }

    const lastRun = lastFor(history, "code.run");
    if (writes.length === 0 && lastRun?.ok) {
      const json = extractJsonObject(lastRun.output);
      if (json) {
        return {
          kind: "tool",
          think: "The solver found a satisfying assignment. Write it out.",
          tool: "file.write",
          args: { path: TARGET, content: json },
        };
      }
    }

    // Recovery: a hasty schedule gets checked and re-solved if the profile allows.
    if (!profile.careful && writes.length === 1 && profile.recovers >= 1 && runs.length === 0) {
      return {
        kind: "tool",
        think: "Worth checking that against the constraints before finishing.",
        tool: "code.run",
        args: { saveAs: "/src/solve.js", source: SOLVER },
      };
    }
    if (!profile.careful && writes.length === 1 && lastRun?.ok) {
      const json = extractJsonObject(lastRun.output);
      if (json) {
        return {
          kind: "tool",
          think: "bo was on call in weeks 1 and 2 back to back. Replace it with the solver's answer.",
          tool: "file.write",
          args: { path: TARGET, content: json },
        };
      }
    }

    return {
      kind: "finish",
      think: "Schedule written.",
      message: profile.careful
        ? `Searched the assignment space and wrote a verified rotation to ${TARGET}.`
        : `Wrote a four-week rotation to ${TARGET}.`,
    };
  }
}

