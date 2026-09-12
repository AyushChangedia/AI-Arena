import type { GradingContext, TaskDefinition, TaskTest } from "../types";
import { contentCheck, fileExistsCheck } from "../types";
import type { PolicyAction, PolicyContext, PolicyProfile, ScriptedPolicy } from "@/lib/agents/policies/types";
import { lastFor } from "@/lib/agents/policies/types";
import { extractJsonObject } from "../util";

/**
 * ANALYSE A MESSY EXPORT
 *
 * Every trap in the data is one of the three failure modes in the corpus's data
 * quality note: blanks coerced to zero, duplicate rows from a join fan-out, and
 * type drift inside a column. The expected values were computed independently
 * and are asserted exactly, so an agent that skips a trap produces a number
 * that is simply wrong.
 */

const TARGET = "/analysis.json";

const CSV = `order_id,region,amount,status
1001,North,120.50,paid
1002,South,89.00,paid
1003,North,,paid
1004,East,"1,234.00",paid
1005,West,45.25,refunded
1006,North,310.00,paid
1002,South,89.00,paid
1007,East,N/A,paid
1008,West,78.40,paid
order_id,region,amount,status
1009,South,"2,100.75",paid
1010,North,15.00,pending
1011,East,640.00,paid
1012,West,220.10,paid
1013,South,99.99,refunded
1014,North,432.00,paid
1015,East,"1,000.00",paid
1006,North,310.00,paid
1016,West,  55.50  ,paid
1017,South,183.30,paid
1018,North,-40.00,paid
1019,East,720.25,paid
1020,West,  ,paid
1021,South,64.00,pending
1022,North,950.00,paid
`;

const SPEC = `# Q3 order export — analysis

\`data/orders.csv\` is a raw export. It is not clean.

Produce \`analysis.json\` with exactly these keys:

    {
      "rowsRead": number,           // physical data rows after the first header
      "headerRowsSkipped": number,  // header lines repeated inside the body
      "duplicatesRemoved": number,  // rows dropped as duplicate order_id
      "invalidAmounts": number,     // unique orders whose amount is unusable
      "paidOrders": number,         // unique, valid, status = paid
      "revenueTotal": number,       // 2 decimal places
      "averageOrderValue": number,  // 2 decimal places
      "topRegion": string,
      "regionRevenue": { "<region>": number }   // 2 decimal places each
    }

## Rules

1. The file is real CSV: a quoted field may contain a comma. Splitting on
   commas will give you the wrong answer.
2. A header line repeated inside the body is not data.
3. \`order_id\` is the unique key. Keep the **first** occurrence, drop later ones,
   and count what you dropped.
4. Amounts may carry thousands separators and surrounding whitespace.
5. An amount that is blank, non-numeric, or **negative** is invalid. Count it and
   exclude the order from every revenue figure. Do not coerce it to zero.
6. Only \`status = paid\` contributes to revenue. \`refunded\` and \`pending\` do not.
7. Round every money value to 2 decimal places.
8. \`topRegion\` is the region with the highest revenue.
`;

/** Independently computed from the fixture above. */
const EXPECTED = {
  rowsRead: 25,
  headerRowsSkipped: 1,
  duplicatesRemoved: 2,
  invalidAmounts: 4,
  paidOrders: 14,
  revenueTotal: 8133.8,
  averageOrderValue: 580.99,
  topRegion: "East",
  regionRevenue: { East: 3594.25, North: 1812.5, South: 2373.05, West: 354.0 },
};

function readAnalysis(ctx: GradingContext): Record<string, unknown> | { error: string } {
  if (!ctx.vfs.isFile(TARGET)) return { error: `${TARGET} was never created` };
  try {
    const parsed: unknown = JSON.parse(ctx.vfs.read(TARGET));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "analysis.json is not a JSON object" };
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    return { error: `analysis.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function numberTest(id: string, key: keyof typeof EXPECTED, tolerance = 0.005): TaskTest {
  return {
    id,
    name: `${String(key)} is correct`,
    run(ctx) {
      const doc = readAnalysis(ctx);
      if ("error" in doc && typeof doc.error === "string") return { passed: false, message: doc.error };
      const actual = (doc as Record<string, unknown>)[key];
      const want = EXPECTED[key] as number;
      if (typeof actual !== "number" || !Number.isFinite(actual)) {
        return { passed: false, message: `expected a number, got ${JSON.stringify(actual) ?? "undefined"}` };
      }
      const ok = Math.abs(actual - want) <= tolerance;
      return { passed: ok, message: ok ? `= ${actual}` : `expected ${want}, got ${actual}` };
    },
  };
}

export const salesAnalysis: TaskDefinition = {
  task: {
    id: "task_sales_analysis",
    slug: "sales-analysis",
    title: "Analyse a messy sales export",
    brief: "Quoted commas, repeated headers, duplicate keys, and amounts that are not numbers.",
    prompt: `Read /SPEC.md, then analyse /data/orders.csv and write ${TARGET}.

The export contains, deliberately: a quoted field with a comma inside it, a header line
repeated mid-file, duplicate order_ids, amounts with thousands separators, amounts that
are blank or "N/A", surrounding whitespace, and one negative amount.

Every one of those changes an answer. The grader asserts the exact expected values, so
a shortcut that ignores any of them produces a wrong number.

Sandboxed code can read the workspace: readFile("/data/orders.csv") returns the text,
and listFiles() enumerates the tree. Write a parser with code.run and check your
intermediate numbers before you commit to them.`,
    category: "data",
    difficulty: "medium",
    limits: { timeLimitMs: 180_000, stepLimit: 28, budgetUsd: 0.5 },
    toolsAllowed: ["file.read", "file.write", "file.list", "shell.exec", "code.run"],
    successConditions: [
      "analysis.json parses and carries all nine keys",
      "Every count and money figure matches the independently computed value",
      "Region revenue is correct for all four regions",
    ],
    evaluation: {
      evaluators: ["tests", "rubric", "trace"],
      weights: {
        "tests.passRate": 0.55,
        "rubric.score": 0.15,
        "efficiency.score": 0.15,
        "resilience.score": 0.1,
        "cost.usd": 0.05,
      },
      weightsOverridden: true,
    },
    seedFiles: [
      { path: "/SPEC.md", content: SPEC, note: "The output contract and cleaning rules" },
      { path: "/data/orders.csv", content: CSV, note: "25 data rows, several of them lying" },
    ],
    targetArtifact: { path: TARGET, kind: "json" },
  },

  environment() {
    return { "/SPEC.md": SPEC, "/data/orders.csv": CSV };
  },

  shellHooks() {
    return {};
  },

  tests: [
    {
      id: "parses",
      name: "analysis.json exists and is valid JSON",
      run(ctx) {
        const doc = readAnalysis(ctx);
        return "error" in doc && typeof doc.error === "string"
          ? { passed: false, message: doc.error }
          : { passed: true, message: `${Object.keys(doc).length} keys` };
      },
    },
    numberTest("rows-read", "rowsRead"),
    numberTest("headers-skipped", "headerRowsSkipped"),
    numberTest("duplicates", "duplicatesRemoved"),
    numberTest("invalid-amounts", "invalidAmounts"),
    numberTest("paid-orders", "paidOrders"),
    numberTest("revenue-total", "revenueTotal"),
    numberTest("aov", "averageOrderValue"),
    {
      id: "top-region",
      name: "topRegion is correct",
      run(ctx) {
        const doc = readAnalysis(ctx);
        if ("error" in doc && typeof doc.error === "string") return { passed: false, message: doc.error };
        const actual = (doc as Record<string, unknown>).topRegion;
        return actual === EXPECTED.topRegion
          ? { passed: true, message: `= ${EXPECTED.topRegion}` }
          : { passed: false, message: `expected ${EXPECTED.topRegion}, got ${JSON.stringify(actual)}` };
      },
    },
    {
      id: "region-revenue",
      name: "regionRevenue is correct for all four regions",
      run(ctx) {
        const doc = readAnalysis(ctx);
        if ("error" in doc && typeof doc.error === "string") return { passed: false, message: doc.error };
        const actual = (doc as Record<string, unknown>).regionRevenue;
        if (!actual || typeof actual !== "object") {
          return { passed: false, message: "regionRevenue is missing or not an object" };
        }
        const map = actual as Record<string, unknown>;
        const wrong: string[] = [];
        for (const [region, want] of Object.entries(EXPECTED.regionRevenue)) {
          const got = map[region];
          if (typeof got !== "number" || Math.abs(got - want) > 0.005) {
            wrong.push(`${region}: expected ${want}, got ${JSON.stringify(got)}`);
          }
        }
        return wrong.length === 0
          ? { passed: true, message: "all four regions correct" }
          : { passed: false, message: wrong.join("; ") };
      },
    },
  ],

  rubric: [
    fileExistsCheck("artifact", "the analysis file exists", TARGET, 1),
    contentCheck(
      "complete-shape",
      "every required key is present",
      TARGET,
      (content) => {
        let doc: Record<string, unknown>;
        try {
          doc = JSON.parse(content) as Record<string, unknown>;
        } catch {
          return { passed: false, score: 0, message: "not valid JSON" };
        }
        const required = Object.keys(EXPECTED);
        const missing = required.filter((k) => !(k in doc));
        return {
          passed: missing.length === 0,
          score: (required.length - missing.length) / required.length,
          message: missing.length === 0 ? "all nine keys" : `missing: ${missing.join(", ")}`,
        };
      },
      2,
    ),
    {
      id: "wrote-a-parser",
      name: "computed the answer with code rather than by hand",
      weight: 2,
      run(ctx: GradingContext) {
        const ran = ctx.events.some(
          (e) => (e.tool === "code.run" || e.tool === "shell.exec") && e.status === "ok",
        );
        return {
          passed: ran,
          score: ran ? 1 : 0,
          message: ran ? "executed a parser in the sandbox" : "no code was executed — the figures were asserted, not computed",
        };
      },
    },
  ],

  policy(profile: PolicyProfile): ScriptedPolicy {
    return new SalesAnalysisPolicy(profile);
  },
};

// ─── demo policy ────────────────────────────────────────────────────────────

/** Handles quoting, repeated headers, duplicates, separators and negatives. */
const CAREFUL_PARSER = `// Parse the export properly: quoted fields, repeated headers, duplicate keys.

function parseCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

function analyse(text) {
  const lines = text.split("\\n").filter((l) => l.trim() !== "");
  const header = lines[0];
  const body = lines.slice(1);

  let headerRowsSkipped = 0;
  let duplicatesRemoved = 0;
  const seen = new Map();

  for (const line of body) {
    if (line.trim() === header.trim()) { headerRowsSkipped++; continue; }
    const cells = parseCsvLine(line);
    const id = (cells[0] || "").trim();
    if (seen.has(id)) { duplicatesRemoved++; continue; }
    seen.set(id, cells);
  }

  let invalidAmounts = 0;
  const paid = [];
  const regionRevenue = {};

  for (const cells of seen.values()) {
    const region = (cells[1] || "").trim();
    const raw = (cells[2] || "").trim().replace(/,/g, "");
    const status = (cells[3] || "").trim();

    const amount = raw === "" ? NaN : Number(raw);
    // Blank, non-numeric and negative all count as invalid — never coerced to 0.
    if (!isFinite(amount) || amount < 0) { invalidAmounts++; continue; }
    if (status !== "paid") continue;

    paid.push(amount);
    regionRevenue[region] = round2((regionRevenue[region] || 0) + amount);
  }

  const revenueTotal = round2(paid.reduce((a, b) => a + b, 0));
  const averageOrderValue = paid.length ? round2(revenueTotal / paid.length) : 0;
  let topRegion = null;
  for (const [region, value] of Object.entries(regionRevenue)) {
    if (topRegion === null || value > regionRevenue[topRegion]) topRegion = region;
  }

  return {
    rowsRead: body.length,
    headerRowsSkipped: headerRowsSkipped,
    duplicatesRemoved: duplicatesRemoved,
    invalidAmounts: invalidAmounts,
    paidOrders: paid.length,
    revenueTotal: revenueTotal,
    averageOrderValue: averageOrderValue,
    topRegion: topRegion,
    regionRevenue: regionRevenue,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = analyse(readFile("/data/orders.csv"));
`;

/** Splits on commas and coerces blanks to zero — both wrong, both common. */
const NAIVE_PARSER = `// Quick pass over the export.
function analyse(text) {
  const lines = text.split("\\n").filter((l) => l.trim() !== "");
  const body = lines.slice(1);
  let total = 0;
  let count = 0;
  const regionRevenue = {};

  for (const line of body) {
    const cells = line.split(",");
    const region = (cells[1] || "").trim();
    const amount = Number((cells[2] || "").trim()) || 0;
    const status = (cells[3] || "").trim();
    if (status !== "paid") continue;
    total += amount;
    count++;
    regionRevenue[region] = Math.round(((regionRevenue[region] || 0) + amount) * 100) / 100;
  }

  let topRegion = null;
  for (const r of Object.keys(regionRevenue)) {
    if (topRegion === null || regionRevenue[r] > regionRevenue[topRegion]) topRegion = r;
  }

  return {
    rowsRead: body.length,
    headerRowsSkipped: 0,
    duplicatesRemoved: 0,
    invalidAmounts: 0,
    paidOrders: count,
    revenueTotal: Math.round(total * 100) / 100,
    averageOrderValue: count ? Math.round((total / count) * 100) / 100 : 0,
    topRegion: topRegion,
    regionRevenue: regionRevenue,
  };
}

module.exports = analyse(readFile("/data/orders.csv"));
`;

class SalesAnalysisPolicy implements ScriptedPolicy {
  readonly id = "sales-analysis";
  readonly describe =
    "Reads the spec and the data, writes a parser, runs it, writes the result. The careless " +
    "profile splits on commas and coerces blanks to zero, which the exact-value assertions catch.";

  constructor(private profile: PolicyProfile) {}

  next(ctx: PolicyContext): PolicyAction {
    const { history, profile } = ctx;
    const reads = history.filter((h) => h.tool === "file.read");
    const codeRuns = history.filter((h) => h.tool === "code.run");
    const writes = history.filter((h) => h.tool === "file.write" && h.args.path === TARGET);

    if (reads.length === 0) {
      return {
        kind: "tool",
        think: "Read the contract — the key names and rounding are asserted exactly.",
        tool: "file.read",
        args: { path: "/SPEC.md" },
      };
    }
    if (reads.length === 1) {
      return {
        kind: "tool",
        think: "Read the raw export before parsing it. The mess is the point.",
        tool: "file.read",
        args: { path: "/data/orders.csv" },
      };
    }

    if (codeRuns.length === 0) {
      return {
        kind: "tool",
        think: profile.careful
          ? "Write a real CSV parser: quoted fields, repeated headers, duplicate keys, separators, negatives."
          : "Split the lines and total the paid rows.",
        tool: "code.run",
        args: {
          saveAs: "/src/analyse.js",
          source: `${profile.careful ? CAREFUL_PARSER : NAIVE_PARSER}\nconsole.log(JSON.stringify(module.exports, null, 2));`,
        },
      };
    }

    const lastRun = lastFor(history, "code.run");

    if (writes.length === 0 && lastRun?.ok) {
      const payload = extractJsonObject(lastRun.output);
      if (payload) {
        return {
          kind: "tool",
          think: "Write the computed result to the deliverable.",
          tool: "file.write",
          args: { path: TARGET, content: payload },
        };
      }
    }

    // Recovery: a careless run that produced nothing usable gets one retry.
    if (!lastRun?.ok && codeRuns.length <= profile.recovers) {
      return {
        kind: "tool",
        think: "The parser threw. Rewrite it properly and re-run.",
        tool: "code.run",
        args: {
          saveAs: "/src/analyse.js",
          source: `${CAREFUL_PARSER}\nconsole.log(JSON.stringify(module.exports, null, 2));`,
        },
      };
    }

    if (writes.length === 0) {
      return {
        kind: "tool",
        think: "Nothing usable came back from the parser; write what is known.",
        tool: "file.write",
        args: { path: TARGET, content: "{}" },
      };
    }

    return {
      kind: "finish",
      think: "Analysis written.",
      message: profile.careful
        ? `Parsed the export with a quoting-aware reader, dropped the repeated header and duplicate order_ids, excluded blank, non-numeric and negative amounts, and wrote ${TARGET}.`
        : `Totalled the paid rows and wrote ${TARGET}.`,
    };
  }
}

