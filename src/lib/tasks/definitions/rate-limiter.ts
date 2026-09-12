import type { TaskDefinition } from "../types";
import { contentCheck, jsTest, jsTruthy, npmTestHook } from "../types";
import type { PolicyAction, PolicyContext, PolicyProfile, ScriptedPolicy } from "@/lib/agents/policies/types";
import { countOf, lastFor } from "@/lib/agents/policies/types";

/**
 * BUILD A TOKEN BUCKET RATE LIMITER
 *
 * A from-scratch implementation task. The grader runs the agent's real code
 * against real timing scenarios; there is no way to pass without a working
 * bucket, because the assertions probe refill arithmetic and retry timing.
 */

const STUB = `// Implement a token bucket rate limiter.
// See README.md for the contract. npm test runs the suite in tests/.

function createLimiter(options) {
  throw new Error("not implemented");
}

module.exports = { createLimiter };
`;

const README = `# rate-limiter

Implement \`createLimiter\` in \`src/limiter.js\`.

## Contract

    const limiter = createLimiter({ capacity: 5, refillPerSec: 1 });
    limiter.tryConsume(key, now, tokens?) -> { allowed, remaining, retryAfterMs }

- \`capacity\` — maximum tokens a bucket can hold. A fresh key starts **full**.
- \`refillPerSec\` — tokens added per second, accruing continuously (fractional
  time counts: 500ms at 2/sec adds exactly 1 token).
- \`now\` — milliseconds, supplied by the caller. Never call \`Date.now()\`
  yourself; the tests drive the clock.
- \`tokens\` — how many to consume, default 1.

## Rules

1. A bucket never exceeds \`capacity\`, no matter how long it sits idle.
2. When enough tokens are available, consume them and return
   \`{ allowed: true, remaining, retryAfterMs: 0 }\`.
3. When not, consume **nothing** and return \`{ allowed: false, remaining, retryAfterMs }\`
   where \`retryAfterMs\` is the whole number of milliseconds until enough
   tokens have accrued (rounded up).
4. A request for more tokens than \`capacity\` can never succeed. Return
   \`allowed: false\` with \`retryAfterMs: Infinity\`.
5. Keys are independent.
6. \`remaining\` is the whole number of tokens left (floored).

    npm test
`;

const VISIBLE_TESTS = `const { createLimiter } = require("../src/limiter");

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(label + " — expected " + b + ", got " + a);
}

module.exports = [
  {
    name: "a fresh bucket starts full",
    fn() {
      const l = createLimiter({ capacity: 3, refillPerSec: 1 });
      eq(l.tryConsume("a", 0).allowed, true, "1st");
      eq(l.tryConsume("a", 0).allowed, true, "2nd");
      eq(l.tryConsume("a", 0).allowed, true, "3rd");
    },
  },
  {
    name: "blocks once the bucket is empty",
    fn() {
      const l = createLimiter({ capacity: 2, refillPerSec: 1 });
      l.tryConsume("a", 0);
      l.tryConsume("a", 0);
      eq(l.tryConsume("a", 0).allowed, false, "3rd request");
    },
  },
  {
    name: "refills continuously over time",
    fn() {
      const l = createLimiter({ capacity: 2, refillPerSec: 2 });
      l.tryConsume("a", 0);
      l.tryConsume("a", 0);
      eq(l.tryConsume("a", 500).allowed, true, "after 500ms at 2/sec");
    },
  },
  {
    name: "never exceeds capacity after a long idle period",
    fn() {
      const l = createLimiter({ capacity: 2, refillPerSec: 5 });
      l.tryConsume("a", 0);
      l.tryConsume("a", 0);
      l.tryConsume("a", 1000000);
      l.tryConsume("a", 1000000);
      eq(l.tryConsume("a", 1000000).allowed, false, "capped at capacity");
    },
  },
  {
    name: "keys are independent",
    fn() {
      const l = createLimiter({ capacity: 1, refillPerSec: 1 });
      l.tryConsume("a", 0);
      eq(l.tryConsume("b", 0).allowed, true, "second key");
    },
  },
  {
    name: "reports retryAfterMs when blocked",
    fn() {
      const l = createLimiter({ capacity: 1, refillPerSec: 2 });
      l.tryConsume("a", 0);
      eq(l.tryConsume("a", 0).retryAfterMs, 500, "500ms to accrue 1 token at 2/sec");
    },
  },
  {
    name: "a blocked request consumes nothing",
    fn() {
      const l = createLimiter({ capacity: 2, refillPerSec: 1 });
      l.tryConsume("a", 0, 2);
      l.tryConsume("a", 0, 2);
      eq(l.tryConsume("a", 1000).allowed, true, "one token accrued and was still there");
    },
  },
  {
    name: "a request larger than capacity can never succeed",
    fn() {
      const l = createLimiter({ capacity: 2, refillPerSec: 1 });
      const r = l.tryConsume("a", 0, 5);
      eq(r.allowed, false, "allowed");
      eq(r.retryAfterMs, null, "retryAfterMs serialises Infinity as null");
    },
  },
];
`;

const L = `require("/src/limiter.js").createLimiter`;

export const rateLimiter: TaskDefinition = {
  task: {
    id: "task_rate_limiter",
    slug: "rate-limiter",
    title: "Build a token bucket rate limiter",
    brief: "From an empty stub. Continuous refill, retry timing, independent keys.",
    prompt: `Implement \`createLimiter\` in /src/limiter.js. The full contract is in /README.md — read it first.

    createLimiter({ capacity, refillPerSec }).tryConsume(key, now, tokens?) -> { allowed, remaining, retryAfterMs }

The traps, in order of how often they are missed:
- Tokens accrue continuously. 500ms at 2 tokens/sec is exactly 1 token, not 0.
- A bucket must never exceed capacity, however long it idles.
- A blocked request must consume nothing.
- retryAfterMs is the whole number of ms until enough tokens exist, rounded up.
- A request larger than capacity can never succeed.

Run \`npm test\` to check your work. The grader runs its own assertions against /src/limiter.js.`,
    category: "coding",
    difficulty: "hard",
    limits: { timeLimitMs: 180_000, stepLimit: 30, budgetUsd: 0.6 },
    toolsAllowed: ["file.read", "file.write", "file.list", "shell.exec", "code.run"],
    successConditions: [
      "All nine authoritative assertions pass",
      "Refill is continuous, not per-interval",
      "Blocked requests consume nothing",
      "Buckets are capped at capacity",
    ],
    evaluation: {
      evaluators: ["tests", "rubric", "trace"],
      weights: {
        "tests.passRate": 0.4,
        "rubric.score": 0.2,
        "quality.code": 0.15,
        "efficiency.score": 0.1,
        "resilience.score": 0.1,
        "cost.usd": 0.05,
      },
      weightsOverridden: false,
    },
    seedFiles: [
      { path: "/README.md", content: README, note: "The contract" },
      { path: "/src/limiter.js", content: STUB, note: "Empty stub to implement" },
      { path: "/tests/limiter.test.js", content: VISIBLE_TESTS, note: "Eight assertions" },
    ],
    targetArtifact: { path: "/src/limiter.js", kind: "code" },
  },

  environment() {
    return {
      "/README.md": README,
      "/src/limiter.js": STUB,
      "/tests/limiter.test.js": VISIBLE_TESTS,
    };
  },

  shellHooks() {
    return { npm: npmTestHook("/tests/limiter.test.js") };
  },

  tests: [
    jsTest(
      "starts-full",
      "a fresh bucket starts full",
      `(function(){ var l = ${L}({capacity:3, refillPerSec:1});
        return [l.tryConsume("a",0).allowed, l.tryConsume("a",0).allowed, l.tryConsume("a",0).allowed]; })()`,
      [true, true, true],
    ),
    jsTest(
      "blocks-when-empty",
      "blocks once the bucket is empty",
      `(function(){ var l = ${L}({capacity:2, refillPerSec:1});
        l.tryConsume("a",0); l.tryConsume("a",0); return l.tryConsume("a",0).allowed; })()`,
      false,
    ),
    jsTest(
      "continuous-refill",
      "refills continuously (500ms at 2/sec is exactly one token)",
      `(function(){ var l = ${L}({capacity:2, refillPerSec:2});
        l.tryConsume("a",0); l.tryConsume("a",0); return l.tryConsume("a",500).allowed; })()`,
      true,
    ),
    jsTest(
      "no-partial-refill",
      "does not grant a token before it has accrued",
      `(function(){ var l = ${L}({capacity:2, refillPerSec:2});
        l.tryConsume("a",0); l.tryConsume("a",0); return l.tryConsume("a",499).allowed; })()`,
      false,
    ),
    jsTest(
      "capped-at-capacity",
      "never exceeds capacity after a long idle period",
      `(function(){ var l = ${L}({capacity:2, refillPerSec:5});
        l.tryConsume("a",0); l.tryConsume("a",0);
        l.tryConsume("a",1000000); l.tryConsume("a",1000000);
        return l.tryConsume("a",1000000).allowed; })()`,
      false,
    ),
    jsTest(
      "independent-keys",
      "keys are independent",
      `(function(){ var l = ${L}({capacity:1, refillPerSec:1});
        l.tryConsume("a",0); return l.tryConsume("b",0).allowed; })()`,
      true,
    ),
    jsTest(
      "retry-after",
      "reports retryAfterMs when blocked",
      `(function(){ var l = ${L}({capacity:1, refillPerSec:2});
        l.tryConsume("a",0); return l.tryConsume("a",0).retryAfterMs; })()`,
      500,
    ),
    jsTest(
      "blocked-consumes-nothing",
      "a blocked request consumes nothing",
      `(function(){ var l = ${L}({capacity:2, refillPerSec:1});
        l.tryConsume("a",0,2); l.tryConsume("a",0,2); return l.tryConsume("a",1000).allowed; })()`,
      true,
    ),
    jsTruthy(
      "over-capacity",
      "a request larger than capacity can never succeed",
      `(function(){ var l = ${L}({capacity:2, refillPerSec:1});
        var r = l.tryConsume("a",0,5);
        return r.allowed === false && (r.retryAfterMs === Infinity || r.retryAfterMs === null); })()`,
    ),
  ],

  rubric: [
    contentCheck(
      "no-wall-clock",
      "does not read the wall clock (the caller drives time)",
      "/src/limiter.js",
      (content) => {
        const cheats = /Date\.now\s*\(/.test(content) || /new\s+Date\s*\(/.test(content);
        return {
          passed: !cheats,
          score: cheats ? 0 : 1,
          message: cheats ? "calls Date.now() — the contract says time comes from the caller" : "clean",
        };
      },
      2,
    ),
    contentCheck(
      "per-key-state",
      "keeps per-key state rather than one global bucket",
      "/src/limiter.js",
      (content) => {
        const perKey = /new Map\(|Object\.create\(null\)|\{\s*\}\s*;?\s*$|buckets/m.test(content);
        return {
          passed: perKey,
          score: perKey ? 1 : 0,
          message: perKey ? "per-key store present" : "no visible per-key store",
        };
      },
      1,
    ),
    contentCheck(
      "documented",
      "the implementation explains its refill arithmetic",
      "/src/limiter.js",
      (content) => {
        const commentLines = content.split("\n").filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length;
        const score = Math.min(1, commentLines / 4);
        return {
          passed: score >= 1,
          score,
          message: `${commentLines} comment line(s)`,
        };
      },
      1,
    ),
  ],

  policy(profile: PolicyProfile): ScriptedPolicy {
    return new RateLimiterPolicy(profile);
  },
};

// ─── demo policy ────────────────────────────────────────────────────────────

const CORRECT = `// Token bucket rate limiter.
//
// Each key holds { tokens, updatedAt }. Tokens accrue continuously at
// refillPerSec, so elapsed milliseconds convert to fractional tokens:
//   accrued = (now - updatedAt) / 1000 * refillPerSec
// The bucket is then clamped to capacity, which is what stops an idle key from
// banking unlimited burst.

function createLimiter(options) {
  const capacity = options.capacity;
  const refillPerSec = options.refillPerSec;
  const buckets = new Map();

  function refill(key, now) {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, updatedAt: now };
      buckets.set(key, b);
      return b;
    }
    const elapsedMs = Math.max(0, now - b.updatedAt);
    b.tokens = Math.min(capacity, b.tokens + (elapsedMs / 1000) * refillPerSec);
    b.updatedAt = now;
    return b;
  }

  return {
    tryConsume(key, now, tokens) {
      const want = typeof tokens === "number" ? tokens : 1;
      const b = refill(key, now);

      // A request bigger than the bucket can never be satisfied.
      if (want > capacity) {
        return { allowed: false, remaining: Math.floor(b.tokens), retryAfterMs: Infinity };
      }

      if (b.tokens >= want) {
        b.tokens -= want;
        return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
      }

      // Blocked: consume nothing, and report how long until enough accrue.
      const deficit = want - b.tokens;
      const retryAfterMs = Math.ceil((deficit / refillPerSec) * 1000);
      return { allowed: false, remaining: Math.floor(b.tokens), retryAfterMs: retryAfterMs };
    },
  };
}

module.exports = { createLimiter };
`;

/** Discrete refill: a classic wrong implementation that fails timing tests. */
const NAIVE = `// Token bucket rate limiter.
function createLimiter(options) {
  const capacity = options.capacity;
  const refillPerSec = options.refillPerSec;
  const buckets = {};

  return {
    tryConsume(key, now, tokens) {
      const want = tokens || 1;
      let b = buckets[key];
      if (!b) b = buckets[key] = { tokens: capacity, updatedAt: now };

      // Refill whole tokens once per elapsed second.
      const seconds = Math.floor((now - b.updatedAt) / 1000);
      if (seconds > 0) {
        b.tokens = b.tokens + seconds * refillPerSec;
        b.updatedAt = now;
      }

      if (b.tokens >= want) {
        b.tokens -= want;
        return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
      }
      return { allowed: false, remaining: Math.floor(b.tokens), retryAfterMs: 1000 };
    },
  };
}

module.exports = { createLimiter };
`;

class RateLimiterPolicy implements ScriptedPolicy {
  readonly id = "rate-limiter";
  readonly describe =
    "Reads the contract, implements, runs the suite. The careless profile ships discrete " +
    "per-second refill and an uncapped bucket, which the timing assertions catch.";

  constructor(private profile: PolicyProfile) {}

  next(ctx: PolicyContext): PolicyAction {
    const { history, profile } = ctx;
    const reads = countOf(history, "file.read");
    const writes = countOf(history, "file.write");
    const runs = history.filter((h) => h.tool === "shell.exec");
    const lastRun = lastFor(history, "shell.exec");

    if (reads === 0) {
      return {
        kind: "tool",
        think: "Read the contract before writing anything.",
        tool: "file.read",
        args: { path: "/README.md" },
      };
    }
    if (profile.explore >= 1 && reads === 1) {
      return {
        kind: "tool",
        think: "Read the suite to see exactly which timings are asserted.",
        tool: "file.read",
        args: { path: "/tests/limiter.test.js" },
      };
    }

    if (writes === 0) {
      return profile.careful
        ? {
            kind: "tool",
            think:
              "Continuous accrual from elapsed milliseconds, clamped to capacity, " +
              "blocked requests consume nothing, retryAfterMs from the deficit.",
            tool: "file.write",
            args: { path: "/src/limiter.js", content: CORRECT },
          }
        : {
            kind: "tool",
            think: "Standard token bucket: refill a token a second, decrement on use.",
            tool: "file.write",
            args: { path: "/src/limiter.js", content: NAIVE },
          };
    }

    if (profile.verifies && runs.length < writes) {
      return {
        kind: "tool",
        think: "Run the suite.",
        tool: "shell.exec",
        args: { command: "npm test" },
      };
    }

    if (lastRun && !lastRun.ok && writes <= profile.recovers) {
      return {
        kind: "tool",
        think:
          "The sub-second refill cases fail — flooring elapsed time to whole seconds " +
          "loses the fractional accrual, and the bucket is never clamped. Rewrite both.",
        tool: "file.write",
        args: { path: "/src/limiter.js", content: CORRECT },
      };
    }

    const passed = lastRun?.ok ?? false;
    return {
      kind: "finish",
      think: passed ? "Suite is green." : "Implementation submitted.",
      message: passed
        ? "Implemented a token bucket with continuous fractional refill clamped to capacity. All assertions pass."
        : "Implemented a token bucket limiter. Sub-second refill behaviour may still be wrong.",
    };
  }
}
