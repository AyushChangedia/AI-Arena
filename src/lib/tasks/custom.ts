import type { Task } from "@/lib/arena/types";
import type { PolicyAction, PolicyContext, PolicyProfile, ScriptedPolicy } from "@/lib/agents/policies/types";
import { fnv1a64 } from "@/lib/sandbox/vfs";
import type { RubricCheck, TaskDefinition, TaskTest } from "./types";
import { contentCheck, coverageCheck } from "./types";
import { analyseBrief, type AnalysedBrief } from "./brief";

/**
 * A task built from a brief somebody typed.
 *
 * ## What is graded, and what is not
 *
 * The built-in tasks assert correctness: nine assertions that know what a
 * working rate limiter does. A typed brief has no such answer key, and
 * inventing one would be worse than having none — a made-up assertion that
 * passes tells you nothing and looks exactly like a real one.
 *
 * So what runs here are the checks that are genuinely decidable without an
 * answer key: the artifact exists, it is structurally sound for its kind, it is
 * substantial, and it is about the thing that was asked for. Those are real
 * assertions over the agent's real output — they fail when the agent produces
 * nothing, produces something malformed, or produces something off-topic.
 *
 * They are a weaker signal than the built-in suites, and the UI says so rather
 * than presenting the two as equivalent.
 */
export function buildCustomTask(rawBrief: string): TaskDefinition {
  const brief = analyseBrief(rawBrief);
  const { artifactPath, kind } = brief;

  const task: Task = {
    id: `task_${brief.slug.replace(/-/g, "_")}`,
    slug: brief.slug,
    title: brief.title,
    brief: brief.text,
    prompt: promptFor(brief),
    category: kind === "page" ? "ui" : kind === "document" ? "reasoning" : "coding",
    difficulty: "medium",
    limits: { stepLimit: 24, timeLimitMs: 150_000, budgetUsd: 0.75 },
    toolsAllowed: [
      "file.read",
      "file.write",
      "file.list",
      "shell.exec",
      "code.run",
      "web.search",
      "web.fetch",
    ],
    successConditions: [
      `${artifactPath} exists and is not a stub`,
      kind === "page" ? "It is a complete HTML document" : "It is well-formed and readable",
      "It addresses the brief rather than something else",
    ],
    evaluation: {
      evaluators: ["tests", "rubric", "trace"],
      // Structure and topical fit are what can be checked, so they carry the
      // weight that correctness carries elsewhere — not more.
      weights: {
        "tests.passRate": 0.4,
        "rubric.score": 0.25,
        "efficiency.score": 0.15,
        "resilience.score": 0.15,
        "cost.usd": 0.05,
      },
      weightsOverridden: true,
    },
    seedFiles: [],
    targetArtifact: {
      path: artifactPath,
      kind: kind === "page" ? "html" : kind === "document" ? "markdown" : "code",
    },
  };

  return {
    task,
    environment: () => ({
      "/BRIEF.md": `# The brief\n\n${brief.text}\n\nWrite your answer to ${artifactPath}.\n`,
    }),
    shellHooks: () => ({}),
    tests: buildTests(brief),
    rubric: buildRubric(brief),
    policy: (profile) => new BriefPolicy(brief, profile),
  };
}

function promptFor(brief: AnalysedBrief): string {
  const shape =
    brief.kind === "page"
      ? "Write a complete, self-contained HTML document — doctype, head with a title, and a body with real content. Inline any CSS; do not link to files that do not exist."
      : brief.kind === "document"
        ? "Write it as Markdown with a top-level heading and clear sections."
        : "Write working JavaScript. Keep it self-contained and runnable.";

  return [
    brief.text,
    "",
    `Write your answer to ${brief.artifactPath}. ${shape}`,
    "Work in the sandbox: read the workspace, write the file, and check your own output before you finish.",
  ].join("\n");
}

// ─── assertions ─────────────────────────────────────────────────────────────

function buildTests(brief: AnalysedBrief): TaskTest[] {
  const path = brief.artifactPath;

  const tests: TaskTest[] = [
    {
      id: "artifact-exists",
      name: `${path} was created`,
      run: (ctx) =>
        ctx.vfs.isFile(path)
          ? { passed: true, message: "file exists" }
          : { passed: false, message: `${path} is missing` },
    },
    {
      id: "artifact-substantial",
      name: "It is more than a stub",
      run: (ctx) => {
        if (!ctx.vfs.isFile(path)) return { passed: false, message: "no file" };
        const bytes = ctx.vfs.read(path).trim().length;
        return bytes >= 400
          ? { passed: true, message: `${bytes} characters` }
          : { passed: false, message: `only ${bytes} characters — too thin to be an answer` };
      },
    },
    {
      id: "addresses-brief",
      name: "It is about what was asked for",
      run: (ctx) => {
        if (!ctx.vfs.isFile(path)) return { passed: false, message: "no file" };
        const content = ctx.vfs.read(path).toLowerCase();
        const hit = brief.keywords.filter((k) => content.includes(k));
        // Half the brief's distinctive words is the line between "about this"
        // and "a generic page that happens to exist".
        const needed = Math.max(1, Math.ceil(brief.keywords.length / 2));
        return hit.length >= needed
          ? { passed: true, message: `mentions ${hit.slice(0, 4).join(", ")}` }
          : {
              passed: false,
              message: `covers ${hit.length}/${brief.keywords.length} of the brief's terms (needs ${needed})`,
            };
      },
    },
  ];

  if (brief.kind === "page") {
    tests.push(
      structural("html-document", "It is a complete HTML document", path, (c) =>
        /<!doctype html>/i.test(c) && /<html[\s>]/i.test(c) && /<\/html>/i.test(c)
          ? null
          : "missing doctype or <html> element",
      ),
      structural("html-head", "It has a head with a title", path, (c) =>
        /<title>\s*\S[^<]*<\/title>/i.test(c) ? null : "no non-empty <title>",
      ),
      structural("html-heading", "It has a visible heading", path, (c) =>
        /<h1[\s>][\s\S]*?<\/h1>/i.test(c) ? null : "no <h1>",
      ),
      structural("html-balanced", "Its body tags are balanced", path, (c) => {
        const open = (c.match(/<body[\s>]/gi) ?? []).length;
        const close = (c.match(/<\/body>/gi) ?? []).length;
        return open === 1 && close === 1 ? null : `found ${open} <body> and ${close} </body>`;
      }),
      structural("html-no-dead-assets", "It does not link to files that do not exist", path, (c) => {
        const refs = [...c.matchAll(/(?:src|href)="(?!https?:|#|data:|mailto:)([^"]+)"/gi)].map((m) => m[1]!);
        return refs.length === 0 ? null : `references ${refs.slice(0, 3).join(", ")}`;
      }),
    );
  } else if (brief.kind === "document") {
    tests.push(
      structural("md-heading", "It opens with a heading", path, (c) =>
        /^#\s+\S/m.test(c) ? null : "no top-level heading",
      ),
      structural("md-sections", "It is broken into sections", path, (c) =>
        (c.match(/^##\s+\S/gm) ?? []).length >= 2 ? null : "fewer than two sections",
      ),
    );
  } else {
    tests.push({
      id: "js-parses",
      name: "The JavaScript parses",
      run: (ctx) => {
        if (!ctx.vfs.isFile(path)) return { passed: false, message: "no file" };
        // Actually executed in the sandbox, so a syntax error or a throw at
        // module scope is a real failure rather than a guess from a regex.
        const result = ctx.executor.run(ctx.vfs, { entry: path, timeoutMs: 4_000 });
        return result.ok
          ? { passed: true, message: "parses and evaluates" }
          : { passed: false, message: result.error?.message ?? "failed to evaluate" };
      },
    });
  }

  return tests;
}

/** A pass/fail check over the artifact's text; the predicate returns why it failed. */
function structural(
  id: string,
  name: string,
  path: string,
  check: (content: string) => string | null,
): TaskTest {
  return {
    id,
    name,
    run: (ctx) => {
      if (!ctx.vfs.isFile(path)) return { passed: false, message: `${path} is missing` };
      const reason = check(ctx.vfs.read(path));
      return reason === null ? { passed: true, message: "ok" } : { passed: false, message: reason };
    },
  };
}

function buildRubric(brief: AnalysedBrief): RubricCheck[] {
  const path = brief.artifactPath;
  const checks: RubricCheck[] = [
    coverageCheck(
      "brief-coverage",
      "How much of the brief it covers",
      path,
      brief.keywords.map((k) => ({ label: k, test: new RegExp(escapeRegex(k), "i") })),
      2,
    ),
    contentCheck(
      "no-placeholders",
      "No placeholder text left in",
      path,
      (content) => {
        const found = ["lorem ipsum", "todo", "tbd", "your text here", "placeholder"].filter((p) =>
          content.toLowerCase().includes(p),
        );
        return found.length === 0
          ? { passed: true, score: 1, message: "none" }
          : { passed: false, score: 0, message: `left in: ${found.join(", ")}` };
      },
      1.5,
    ),
  ];

  if (brief.kind === "page") {
    checks.push(
      coverageCheck(
        "page-structure",
        "It reads like a real page",
        path,
        [
          { label: "styling", test: /<style[\s>]|style="/i },
          { label: "sections", test: /<(section|main|article)[\s>]/i },
          { label: "navigation or footer", test: /<(nav|footer|header)[\s>]/i },
          { label: "a call to action", test: /<(a|button)[\s>]/i },
          { label: "responsive viewport", test: /name="viewport"/i },
        ],
        2,
      ),
    );
  }

  return checks;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── the demo brain ─────────────────────────────────────────────────────────

/**
 * The scripted policy for an arbitrary brief.
 *
 * Every other demo policy was authored against a task whose shape was known in
 * advance. This one cannot be: it has to produce something for a brief nobody
 * wrote a script for. What it does is real — it reads the workspace, composes an
 * artifact from the brief's own words, writes it through the real tool layer and
 * verifies it — but the composition is a template, not comprehension. A demo
 * custom match therefore shows the machinery working end to end on your brief;
 * it does not show an agent understanding it.
 *
 * That is the same bargain every DEMO match makes, and the UI labels it the same
 * way. Connect a provider and a real model writes this file instead.
 */
class BriefPolicy implements ScriptedPolicy {
  readonly id = "policy.custom-brief";
  readonly describe =
    "Reads the brief, composes an artifact from its own terms, writes it and verifies the result. Template-composed, not reasoned — set an API key to have a model write it.";

  constructor(
    private readonly brief: AnalysedBrief,
    private readonly profile: PolicyProfile,
  ) {}

  next(ctx: PolicyContext): PolicyAction {
    const { profile, brief } = this;
    const done = new Set(ctx.history.map((h) => h.tool).filter(Boolean) as string[]);
    const wrote = ctx.history.some((h) => h.tool === "file.write" && h.ok);

    // Look before writing. Deeper planners look longer, and pay for it in the
    // efficiency dimension — the same trade every other policy makes.
    if (ctx.step === 0 && profile.explore > 0 && ctx.catalogue.has("file.list")) {
      return {
        kind: "tool",
        think: "See what the workspace already contains before adding to it.",
        tool: "file.list",
        args: { path: "/" },
      };
    }
    if (ctx.step <= profile.explore && !done.has("file.read") && ctx.catalogue.has("file.read")) {
      return {
        kind: "tool",
        think: "Read the brief as it was given, rather than as I remember it.",
        tool: "file.read",
        args: { path: "/BRIEF.md" },
      };
    }

    if (!wrote && ctx.catalogue.has("file.write")) {
      return {
        kind: "tool",
        think: `Compose the ${brief.kind} and write it to ${brief.artifactPath}.`,
        tool: "file.write",
        args: { path: brief.artifactPath, content: compose(brief, profile) },
      };
    }

    if (wrote && profile.verifies && !done.has("file.read") && ctx.catalogue.has("file.read")) {
      return {
        kind: "tool",
        think: "Read back what was written rather than assuming the write landed.",
        tool: "file.read",
        args: { path: brief.artifactPath },
      };
    }

    return {
      kind: "finish",
      think: "The artifact is written and checked.",
      message: `Wrote ${brief.artifactPath} covering ${brief.keywords.slice(0, 3).join(", ")}.`,
    };
  }
}

/** Builds the artifact out of the brief's own words. Deterministic per brief. */
function compose(brief: AnalysedBrief, profile: PolicyProfile): string {
  const title = brief.title;
  const terms = brief.keywords;
  // Deterministic per (seed, agent) so two agents differ, and reruns do not.
  const variant = Math.floor(profile.rng() * 3);

  if (brief.kind === "document") {
    return [
      `# ${title}`,
      "",
      `This document responds to the brief: “${brief.text}”.`,
      "",
      "## Summary",
      "",
      `The request centres on ${terms.slice(0, 3).join(", ")}. This section sets out what was asked`,
      "for and the shape of the response that follows.",
      "",
      "## Approach",
      "",
      ...terms.slice(0, 4).map((t) => `- **${t}** — addressed directly, with the brief's wording kept intact.`),
      "",
      "## Detail",
      "",
      `Each of ${terms.slice(0, 3).join(", ")} is covered below in the order the brief raised them,`,
      "so the response can be read against the request line by line.",
      "",
      "## Result",
      "",
      `A ${brief.kind} covering ${terms.join(", ")}, written to the path the brief specified.`,
      "",
    ].join("\n");
  }

  if (brief.kind === "code") {
    return [
      `// ${title}`,
      `// Brief: ${brief.text}`,
      "",
      `const TOPIC = ${JSON.stringify(terms[0] ?? "solution")};`,
      "",
      "/** Returns a description of what this module addresses. */",
      "function describe() {",
      `  return ${JSON.stringify(`Handles ${terms.slice(0, 3).join(", ")}`)};`,
      "}",
      "",
      "/** The brief's requirements, kept as data so they can be checked. */",
      `const REQUIREMENTS = ${JSON.stringify(terms, null, 2)};`,
      "",
      "function run() {",
      "  return { topic: TOPIC, requirements: REQUIREMENTS, summary: describe() };",
      "}",
      "",
      "module.exports = { describe, run, REQUIREMENTS, TOPIC };",
      "",
    ].join("\n");
  }

  // A page. Self-contained: inline styles only, so nothing references a file
  // that does not exist — which the assertions check for.
  const accents = ["#e8a33d", "#4ecdc4", "#c98bdb"];
  const accent = accents[variant] ?? accents[0]!;
  const sections = terms.slice(0, 3);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0b0d10; color: #e6eaee; line-height: 1.6; }
  header, main, footer { max-width: 960px; margin: 0 auto; padding: 24px; }
  nav { display: flex; gap: 20px; border-bottom: 1px solid #232a31; padding-bottom: 16px; }
  nav a { color: #9aa5af; text-decoration: none; font-size: 14px; }
  h1 { font-size: clamp(30px, 6vw, 52px); line-height: 1.1; margin: 40px 0 16px; }
  .accent { color: ${accent}; }
  .lede { font-size: 18px; color: #9aa5af; max-width: 60ch; }
  .cta { display: inline-block; margin-top: 28px; background: ${accent}; color: #0b0d10; padding: 13px 26px; font-weight: 600; text-decoration: none; }
  section { border-top: 1px solid #232a31; padding: 32px 0; }
  .grid { display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  footer { border-top: 1px solid #232a31; color: #6b7681; font-size: 14px; }
</style>
</head>
<body>
<header>
  <nav>
    <a href="#about">About</a>
    <a href="#offer">What we offer</a>
    <a href="#visit">Visit</a>
  </nav>
  <h1>${escapeHtml(title)}<span class="accent">.</span></h1>
  <p class="lede">${escapeHtml(brief.text)}</p>
  <a class="cta" href="#visit">Get started</a>
</header>
<main>
  <section id="about">
    <h2>About</h2>
    <p>Built to the brief: ${escapeHtml(brief.text)}</p>
  </section>
  <section id="offer">
    <h2>What we offer</h2>
    <div class="grid">
${sections
  .map(
    (term) =>
      `      <article>\n        <h3>${escapeHtml(capitalise(term))}</h3>\n        <p>Everything here is built around ${escapeHtml(term)}, as the brief asked.</p>\n      </article>`,
  )
  .join("\n")}
    </div>
  </section>
  <section id="visit">
    <h2>Visit</h2>
    <p>Open every day. Covering ${escapeHtml(terms.join(", "))}.</p>
  </section>
</main>
<footer>
  <p>${escapeHtml(title)} — generated in the AI Agent Arena from the brief above.</p>
</footer>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Stable id for a brief, so the same text always names the same task. */
export function customTaskId(brief: string): string {
  return `task_custom_${fnv1a64(brief.trim().replace(/\s+/g, " ")).slice(0, 10)}`;
}
