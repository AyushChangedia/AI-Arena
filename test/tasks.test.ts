import { describe, expect, it } from "vitest";
import { allTaskDefinitions, getTaskDefinition, allTasks } from "@/lib/tasks";
import { Vfs } from "@/lib/sandbox/vfs";
import { NodeVmExecutor } from "@/lib/sandbox/vm";
import { VirtualShell } from "@/lib/sandbox/shell";
import { TOOL_NAMES } from "@/lib/tools/registry";
import type { GradingContext } from "@/lib/tasks/types";

const executor = new NodeVmExecutor();

function contextFor(slug: string, overrides: Record<string, string> = {}): GradingContext {
  const def = getTaskDefinition(slug)!;
  const vfs = Vfs.fromSnapshot({ ...def.environment("seed"), ...overrides });
  return { vfs, executor, events: [], task: def.task };
}

async function runTests(slug: string, overrides: Record<string, string> = {}) {
  const def = getTaskDefinition(slug)!;
  const ctx = contextFor(slug, overrides);
  const results = [];
  for (const t of def.tests) results.push({ id: t.id, ...(await t.run(ctx)) });
  return results;
}

describe("task library integrity", () => {
  it("every task has a unique id and slug", () => {
    const ids = allTasks().map((t) => t.id);
    const slugs = allTasks().map((t) => t.slug);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every task only allows tools that exist", () => {
    for (const t of allTasks()) {
      for (const tool of t.toolsAllowed) {
        expect(TOOL_NAMES, `${t.slug} allows unknown tool ${tool}`).toContain(tool);
      }
    }
  });

  it("every task declares weights that sum to 1", () => {
    for (const t of allTasks()) {
      const sum = Object.values(t.evaluation.weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1), `${t.slug} weights sum to ${sum}`).toBeLessThan(1e-9);
    }
  });

  it("every task builds a deterministic environment", () => {
    for (const def of allTaskDefinitions()) {
      const a = Vfs.fromSnapshot(def.environment("seed-1"));
      const b = Vfs.fromSnapshot(def.environment("seed-1"));
      expect(a.hash(), def.task.slug).toBe(b.hash());
    }
  });

  it("every seed file listed on the task is actually materialised", () => {
    for (const def of allTaskDefinitions()) {
      const env = def.environment("seed");
      for (const f of def.task.seedFiles) {
        expect(env[f.path], `${def.task.slug} missing ${f.path}`).toBeDefined();
      }
    }
  });

  it("no task ships an environment that already passes its own graders", async () => {
    for (const def of allTaskDefinitions()) {
      if (def.tests.length === 0) continue;
      const ctx = contextFor(def.task.slug);
      const outcomes = [];
      for (const t of def.tests) outcomes.push(await t.run(ctx));
      const passing = outcomes.filter((o) => o.passed).length;
      expect(passing, `${def.task.slug} starts fully solved`).toBeLessThan(def.tests.length);
    }
  });
});

describe("repair-auth graders", () => {
  it("the seeded module fails exactly the assertions its three defects cause", async () => {
    const results = await runTests("repair-auth");
    const failed = results.filter((r) => !r.passed).map((r) => r.id).sort();
    // Inverted expiry breaks two, the missing guard breaks the null case, and
    // `indexOf(...) > 0` breaks only the first-position lookup. The rest of the
    // module genuinely works — it is a repair task, not a rewrite.
    expect(failed).toEqual(["fresh-token", "expired-token", "null-token", "role-first"].sort());
  });

  it("a correct repair passes every assertion", async () => {
    const fixed = `
const SECRET = "arena-dev-secret";
function sign(payload) {
  let h = 2166136261;
  const input = payload + SECRET;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function createToken(userId, ttlMs, now) {
  const issuedAt = typeof now === "number" ? now : Date.now();
  const expiresAt = issuedAt + ttlMs;
  const payload = userId + "." + expiresAt;
  return payload + "." + sign(payload);
}
function verifyToken(token, now) {
  if (typeof token !== "string" || token.length === 0) return null;
  const at = typeof now === "number" ? now : Date.now();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, signature] = parts;
  if (!userId || !expiresAt || !signature) return null;
  if (sign(userId + "." + expiresAt) !== signature) return null;
  if (Number(expiresAt) <= at) return null;
  return { userId: userId, expiresAt: Number(expiresAt) };
}
function hasRole(user, role) {
  if (!user || !Array.isArray(user.roles)) return false;
  return user.roles.indexOf(role) >= 0;
}
module.exports = { createToken, verifyToken, hasRole, sign };
`;
    const results = await runTests("repair-auth", { "/src/auth.js": fixed });
    const failed = results.filter((r) => !r.passed);
    expect(failed.map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  });

  it("npm test reports real failures against the seeded module", async () => {
    const def = getTaskDefinition("repair-auth")!;
    const vfs = Vfs.fromSnapshot(def.environment("s"));
    const shell = new VirtualShell({ vfs, executor, hooks: def.shellHooks(executor) });
    const r = await shell.exec("npm test");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/FAIL/);
    expect(r.stdout).toMatch(/\d+\/8 passing/);
  });

  it("weakening the visible tests does not change the grade", async () => {
    const weakened = `module.exports = [{ name: "always passes", fn() {} }];`;
    const pristine = (await runTests("repair-auth")).filter((r) => !r.passed).map((r) => r.id);
    const gamed = (await runTests("repair-auth", { "/tests/auth.test.js": weakened }))
      .filter((r) => !r.passed)
      .map((r) => r.id);
    expect(gamed).toEqual(pristine);

    // …while `npm test` happily reports green, which is exactly the trap.
    const def = getTaskDefinition("repair-auth")!;
    const vfs = Vfs.fromSnapshot({ ...def.environment("s"), "/tests/auth.test.js": weakened });
    const shell = new VirtualShell({ vfs, executor, hooks: def.shellHooks(executor) });
    expect((await shell.exec("npm test")).exitCode).toBe(0);
  });
});

describe("rate-limiter graders", () => {
  it("the empty stub fails everything", async () => {
    const results = await runTests("rate-limiter");
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it("a correct implementation passes every assertion", async () => {
    const impl = `
function createLimiter(options) {
  const capacity = options.capacity;
  const refillPerSec = options.refillPerSec;
  const buckets = new Map();
  function refill(key, now) {
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, updatedAt: now }; buckets.set(key, b); return b; }
    const elapsed = Math.max(0, now - b.updatedAt);
    b.tokens = Math.min(capacity, b.tokens + (elapsed / 1000) * refillPerSec);
    b.updatedAt = now;
    return b;
  }
  return {
    tryConsume(key, now, tokens) {
      const want = typeof tokens === "number" ? tokens : 1;
      const b = refill(key, now);
      if (want > capacity) return { allowed: false, remaining: Math.floor(b.tokens), retryAfterMs: Infinity };
      if (b.tokens >= want) { b.tokens -= want; return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 }; }
      const deficit = want - b.tokens;
      return { allowed: false, remaining: Math.floor(b.tokens), retryAfterMs: Math.ceil((deficit / refillPerSec) * 1000) };
    },
  };
}
module.exports = { createLimiter };
`;
    const results = await runTests("rate-limiter", { "/src/limiter.js": impl });
    expect(results.filter((r) => !r.passed).map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  });

  it("a discrete-refill implementation fails the sub-second timing assertions", async () => {
    const naive = `
function createLimiter(options) {
  const capacity = options.capacity, refillPerSec = options.refillPerSec, buckets = {};
  return {
    tryConsume(key, now, tokens) {
      const want = tokens || 1;
      let b = buckets[key];
      if (!b) b = buckets[key] = { tokens: capacity, updatedAt: now };
      const seconds = Math.floor((now - b.updatedAt) / 1000);
      if (seconds > 0) { b.tokens += seconds * refillPerSec; b.updatedAt = now; }
      if (b.tokens >= want) { b.tokens -= want; return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 }; }
      return { allowed: false, remaining: Math.floor(b.tokens), retryAfterMs: 1000 };
    },
  };
}
module.exports = { createLimiter };
`;
    const results = await runTests("rate-limiter", { "/src/limiter.js": naive });
    const failed = results.filter((r) => !r.passed).map((r) => r.id);
    expect(failed).toContain("continuous-refill");
    expect(failed).toContain("capped-at-capacity");
    expect(failed).toContain("retry-after");
    // …but it does get the easy ones right, so it is a partial score, not a zero.
    expect(results.filter((r) => r.passed).length).toBeGreaterThan(2);
  });
});

describe("sales-analysis graders", () => {
  it("no analysis file fails every assertion", async () => {
    const results = await runTests("sales-analysis");
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it("the independently computed answer passes every assertion", async () => {
    const answer = JSON.stringify({
      rowsRead: 25,
      headerRowsSkipped: 1,
      duplicatesRemoved: 2,
      invalidAmounts: 4,
      paidOrders: 14,
      revenueTotal: 8133.8,
      averageOrderValue: 580.99,
      topRegion: "East",
      regionRevenue: { East: 3594.25, North: 1812.5, South: 2373.05, West: 354.0 },
    });
    const results = await runTests("sales-analysis", { "/analysis.json": answer });
    expect(results.filter((r) => !r.passed).map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  });

  it("a naive comma-split answer is caught", async () => {
    const wrong = JSON.stringify({
      rowsRead: 25,
      headerRowsSkipped: 0,
      duplicatesRemoved: 0,
      invalidAmounts: 0,
      paidOrders: 19,
      revenueTotal: 4200.0,
      averageOrderValue: 221.05,
      topRegion: "North",
      regionRevenue: { East: 1, North: 2, South: 3, West: 4 },
    });
    const results = await runTests("sales-analysis", { "/analysis.json": wrong });
    expect(results.filter((r) => !r.passed).length).toBeGreaterThanOrEqual(7);
    // The shape check still passes, so it is not a zero.
    expect(results.find((r) => r.id === "parses")?.passed).toBe(true);
  });
});

describe("oncall-rotation graders", () => {
  it("no schedule fails every constraint", async () => {
    const results = await runTests("oncall-rotation");
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it("a valid schedule passes all ten constraints", async () => {
    const valid = JSON.stringify({
      weeks: [
        { week: 1, primary: "ana", secondary: "bo" },
        { week: 2, primary: "eli", secondary: "cy" },
        { week: 3, primary: "bo", secondary: "fin" },
        { week: 4, primary: "dee", secondary: "ana" },
      ],
    });
    const results = await runTests("oncall-rotation", { "/schedule.json": valid });
    expect(results.filter((r) => !r.passed).map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  });

  it("catches a consecutive-week violation specifically", async () => {
    const bad = JSON.stringify({
      weeks: [
        { week: 1, primary: "ana", secondary: "bo" },
        { week: 2, primary: "bo", secondary: "cy" },
        { week: 3, primary: "eli", secondary: "fin" },
        { week: 4, primary: "dee", secondary: "cy" },
      ],
    });
    const results = await runTests("oncall-rotation", { "/schedule.json": bad });
    const failed = results.filter((r) => !r.passed).map((r) => r.id);
    expect(failed).toContain("no-consecutive");
    expect(results.find((r) => r.id === "dee-unavailable")?.passed).toBe(true);
  });

  it("catches each individual constraint violation", async () => {
    const cases: [string, unknown][] = [
      [
        "cy-secondary-only",
        { weeks: [
          { week: 1, primary: "cy", secondary: "bo" },
          { week: 2, primary: "eli", secondary: "ana" },
          { week: 3, primary: "bo", secondary: "fin" },
          { week: 4, primary: "dee", secondary: "ana" },
        ] },
      ],
      [
        "ana-fin-split",
        { weeks: [
          { week: 1, primary: "ana", secondary: "fin" },
          { week: 2, primary: "eli", secondary: "cy" },
          { week: 3, primary: "bo", secondary: "fin" },
          { week: 4, primary: "dee", secondary: "ana" },
        ] },
      ],
      [
        "dee-unavailable",
        { weeks: [
          { week: 1, primary: "ana", secondary: "bo" },
          { week: 2, primary: "dee", secondary: "cy" },
          { week: 3, primary: "bo", secondary: "fin" },
          { week: 4, primary: "eli", secondary: "ana" },
        ] },
      ],
    ];
    for (const [expectFailing, schedule] of cases) {
      const results = await runTests("oncall-rotation", { "/schedule.json": JSON.stringify(schedule) });
      expect(results.filter((r) => !r.passed).map((r) => r.id), expectFailing).toContain(expectFailing);
    }
  });
});

describe("landing-page graders", () => {
  it("no page fails every structural assertion", async () => {
    const results = await runTests("landing-page");
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it("a compliant page passes every structural assertion", async () => {
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — incident timelines</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--fg:#e6eaee;--dim:#8b959f;--line:#1e242b;--accent:#e8a33d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:0 24px}
h1{font-size:clamp(36px,6vw,64px);line-height:1.05;letter-spacing:-0.03em;margin:0 0 20px}
h2{font-size:19px;margin:0 0 8px}
p{color:var(--dim);margin:0}
a{color:var(--accent);text-decoration:none}
a:hover,a:focus-visible{text-decoration:underline}
header,footer{border-color:var(--line)}
section{padding:40px 0;border-top:1px solid var(--line)}
footer{border-top:1px solid var(--line);padding:24px;color:var(--dim)}
</style></head>
<body><header><nav><a href="#features">Features</a></nav></header>
<main><h1>The first twenty minutes of an outage are spent building a timeline</h1>
<a href="#start">Start a free trial</a>
<section><h2>One timeline</h2><p>Meridian pulls logs, alerts and deploys onto a single scrubable timeline so you stop reconciling tabs by timestamp.</p></section>
<section><h2>Full resolution</h2><p>Every event inside the incident window is kept rather than rolled up, so the twelve seconds that matter are actually there.</p></section>
<section><h2>Shareable</h2><p>Export the timeline as a link with the window you were looking at, and start the review from what happened.</p></section>
</main><footer>Meridian</footer></body></html>`;
    const results = await runTests("landing-page", { "/build/index.html": html });
    expect(results.filter((r) => !r.passed).map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  });

  it("catches external resources and a missing viewport", async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>X</title><link rel="stylesheet" href="https://cdn.example/x.css"></head>
<body><header><nav>n</nav></header><main><h1>A</h1></main><footer>f</footer></body></html>`;
    const results = await runTests("landing-page", { "/build/index.html": html });
    const failed = results.filter((r) => !r.passed).map((r) => r.id);
    expect(failed).toContain("self-contained");
    expect(failed).toContain("head");
    expect(failed).toContain("three-features");
  });
});
