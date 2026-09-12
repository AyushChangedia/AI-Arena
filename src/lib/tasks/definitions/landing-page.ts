import type { GradingContext, TaskDefinition, TaskTest } from "../types";
import { contentCheck, fileExistsCheck } from "../types";
import type { PolicyAction, PolicyContext, PolicyProfile, ScriptedPolicy } from "@/lib/agents/policies/types";
import { countOf } from "@/lib/agents/policies/types";

/**
 * BUILD A LANDING PAGE
 *
 * Graded by structural assertions over the produced HTML — landmarks, heading
 * hierarchy, self-containment, accessibility basics. These are real checks on
 * the real artifact, and the artifact viewer renders it so a human can see what
 * the agent actually built.
 */

const BRIEF = `# Brief — Meridian

Meridian is an incident timeline tool for on-call engineers. It reconstructs what
happened during an outage from your logs, alerts and deploys, on one scrubable
timeline.

Audience: engineering teams of 10–200 who already have monitoring and still spend
the first twenty minutes of an incident working out the order of events.

## Deliverable

A single self-contained page at \`build/index.html\`.

## Requirements

1. Valid HTML5: doctype, \`<html lang>\`, \`<head>\`, \`<title>\`, charset and viewport meta.
2. Exactly one \`<h1>\`.
3. Landmarks: \`<header>\`, \`<main>\`, \`<footer>\`, and a \`<nav>\`.
4. Three feature sections, each with its own \`<h2>\` and a paragraph.
5. A primary call to action: an \`<a>\` element whose text asks for the action.
6. Self-contained — CSS in a \`<style>\` block. No external stylesheets, fonts,
   scripts or images. The page must render with no network.
7. Every \`<img>\`, if you use any, carries an \`alt\` attribute.
8. Dark theme. Readable. Not a wireframe.

## Voice

Direct and technical. The reader is an engineer who has been paged at 3am.
No "revolutionize", no "unlock", no "seamlessly".
`;

const TARGET = "/build/index.html";

/** Structural assertions over the produced HTML. Deterministic, not opinions. */
function htmlTest(id: string, name: string, check: (html: string) => { passed: boolean; message: string }): TaskTest {
  return {
    id,
    name,
    run(ctx: GradingContext) {
      if (!ctx.vfs.isFile(TARGET)) {
        return { passed: false, message: `${TARGET} was never created` };
      }
      return check(ctx.vfs.read(TARGET));
    },
  };
}

const BANNED_WORDS = ["revolutionize", "revolutionise", "unlock the power", "seamlessly", "supercharge", "next-generation"];

export const landingPage: TaskDefinition = {
  task: {
    id: "task_landing_page",
    slug: "landing-page",
    title: "Build a landing page",
    brief: "One self-contained HTML file. Structure, accessibility and copy are all graded.",
    prompt: `Read /BRIEF.md and build the page it describes at ${TARGET}.

It is graded on structure, not taste: doctype and lang, a single h1, header/nav/main/footer
landmarks, three feature sections each with an h2 and a paragraph, a call-to-action link,
alt text on any image, and complete self-containment — CSS inside a <style> block, no
external stylesheets, fonts, scripts or images of any kind.

The copy is graded too. Banned: ${BANNED_WORDS.slice(0, 4).join(", ")}.

Write the file, then read it back to check what you actually produced.`,
    category: "ui",
    difficulty: "medium",
    limits: { timeLimitMs: 150_000, stepLimit: 24, budgetUsd: 0.5 },
    toolsAllowed: ["file.read", "file.write", "file.list", "shell.exec"],
    successConditions: [
      "build/index.html exists and is a complete HTML5 document",
      "Exactly one h1, three h2 feature sections",
      "All four landmarks present",
      "No external resource references",
    ],
    evaluation: {
      evaluators: ["tests", "rubric", "trace"],
      weights: {
        "tests.passRate": 0.45,
        "rubric.score": 0.25,
        "quality.code": 0.1,
        "efficiency.score": 0.15,
        "cost.usd": 0.05,
      },
      weightsOverridden: true,
    },
    seedFiles: [{ path: "/BRIEF.md", content: BRIEF, note: "The brief" }],
    targetArtifact: { path: TARGET, kind: "html" },
  },

  environment() {
    return { "/BRIEF.md": BRIEF };
  },

  shellHooks() {
    return {};
  },

  tests: [
    htmlTest("doctype", "declares an HTML5 doctype and a language", (html) => {
      const doctype = /^\s*<!doctype html>/i.test(html);
      const lang = /<html[^>]*\slang\s*=\s*["'][a-z]{2}/i.test(html);
      return {
        passed: doctype && lang,
        message: doctype ? (lang ? "ok" : "missing lang on <html>") : "missing <!doctype html>",
      };
    }),
    htmlTest("head", "has a title, charset and viewport", (html) => {
      const title = /<title>[^<]{3,}<\/title>/i.test(html);
      const charset = /<meta[^>]+charset/i.test(html);
      const viewport = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html);
      const missing = [!title && "title", !charset && "charset", !viewport && "viewport"].filter(Boolean);
      return { passed: missing.length === 0, message: missing.length ? `missing: ${missing.join(", ")}` : "ok" };
    }),
    htmlTest("single-h1", "has exactly one h1", (html) => {
      const n = (html.match(/<h1[\s>]/gi) ?? []).length;
      return { passed: n === 1, message: n === 1 ? "ok" : `found ${n}` };
    }),
    htmlTest("landmarks", "has header, nav, main and footer landmarks", (html) => {
      const missing = ["header", "nav", "main", "footer"].filter(
        (tag) => !new RegExp(`<${tag}[\\s>]`, "i").test(html),
      );
      return { passed: missing.length === 0, message: missing.length ? `missing: ${missing.join(", ")}` : "ok" };
    }),
    htmlTest("three-features", "has at least three h2 feature sections", (html) => {
      const n = (html.match(/<h2[\s>]/gi) ?? []).length;
      return { passed: n >= 3, message: n >= 3 ? `${n} sections` : `found ${n}, needs 3` };
    }),
    htmlTest("sections-have-prose", "each section carries real prose, not just a heading", (html) => {
      const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim())
        .filter((t) => t.length >= 40);
      return {
        passed: paragraphs.length >= 3,
        message: `${paragraphs.length} substantial paragraph(s), needs 3`,
      };
    }),
    htmlTest("cta", "has a call-to-action link", (html) => {
      const anchors = [...html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) =>
        (m[1] ?? "").replace(/<[^>]+>/g, "").trim(),
      );
      const cta = anchors.find((t) =>
        /\b(start|try|get|book|see|watch|request|join|sign)\b/i.test(t),
      );
      return {
        passed: Boolean(cta),
        message: cta ? `"${cta.slice(0, 40)}"` : `${anchors.length} link(s), none reads as a CTA`,
      };
    }),
    htmlTest("self-contained", "references no external resources", (html) => {
      const external = [
        ...(html.match(/<link[^>]+href\s*=\s*["']https?:/gi) ?? []),
        ...(html.match(/<script[^>]+src\s*=\s*["']https?:/gi) ?? []),
        ...(html.match(/<img[^>]+src\s*=\s*["']https?:/gi) ?? []),
        ...(html.match(/@import\s+url\(["']?https?:/gi) ?? []),
      ];
      return {
        passed: external.length === 0,
        message: external.length === 0 ? "fully self-contained" : `${external.length} external reference(s)`,
      };
    }),
    htmlTest("styled", "carries its own stylesheet", (html) => {
      const style = /<style[\s>][\s\S]{200,}<\/style>/i.test(html);
      return { passed: style, message: style ? "ok" : "no substantial <style> block" };
    }),
    htmlTest("img-alt", "every image has alt text", (html) => {
      const imgs = html.match(/<img[^>]*>/gi) ?? [];
      const bad = imgs.filter((t) => !/\salt\s*=/i.test(t));
      return {
        passed: bad.length === 0,
        message: imgs.length === 0 ? "no images used" : `${imgs.length - bad.length}/${imgs.length} with alt`,
      };
    }),
  ],

  rubric: [
    fileExistsCheck("artifact", "the deliverable exists at the required path", TARGET, 1),
    contentCheck(
      "copy-voice",
      "the copy avoids banned marketing language",
      TARGET,
      (html) => {
        const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").toLowerCase();
        const found = BANNED_WORDS.filter((w) => text.includes(w));
        return {
          passed: found.length === 0,
          score: found.length === 0 ? 1 : Math.max(0, 1 - found.length * 0.5),
          message: found.length === 0 ? "clean" : `used: ${found.join(", ")}`,
        };
      },
      2,
    ),
    contentCheck(
      "substance",
      "the page has real content, not a skeleton",
      TARGET,
      (html) => {
        const text = html
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const words = text ? text.split(" ").length : 0;
        const score = Math.min(1, words / 140);
        return { passed: score >= 1, score, message: `${words} words of copy` };
      },
      1,
    ),
    contentCheck(
      "dark-theme",
      "renders as a dark theme as briefed",
      TARGET,
      (html) => {
        const styles = (html.match(/<style[\s\S]*?<\/style>/i)?.[0] ?? "").toLowerCase();
        const dark =
          /background[^;]*:\s*(#0|#1|#2|rgb\(\s*[0-3]?\d\s*,|black)/.test(styles) ||
          /color-scheme:\s*dark/.test(styles);
        return { passed: dark, score: dark ? 1 : 0, message: dark ? "dark ground set" : "no dark background found" };
      },
      1,
    ),
    {
      // Reads the real trace: did the agent verify its own output after writing it?
      id: "verified-own-work",
      name: "the agent read back what it wrote",
      weight: 1,
      run(ctx: GradingContext) {
        const writeAt = ctx.events.findIndex(
          (e) => e.type === "agent.file_created" || e.type === "agent.file_modified",
        );
        const readAfterWrite =
          writeAt >= 0 &&
          ctx.events
            .slice(writeAt + 1)
            .some((e) => e.tool === "file.read" && String(e.data?.path ?? "") === TARGET);
        return {
          passed: readAfterWrite,
          score: readAfterWrite ? 1 : 0,
          message: readAfterWrite
            ? "read the artifact back after writing it"
            : "never inspected the file it produced",
        };
      },
    },
  ],

  policy(profile: PolicyProfile): ScriptedPolicy {
    return new LandingPagePolicy(profile);
  },
};

// ─── demo policy ────────────────────────────────────────────────────────────

function page(complete: boolean): string {
  const features = [
    {
      h: "One timeline, every source",
      p: "Meridian pulls logs, alerts, deploys and status changes onto a single scrubable timeline. You stop reconciling four tabs by timestamp and start reading one sequence.",
    },
    {
      h: "Reconstructed, not sampled",
      p: "Every event inside the incident window is kept, not rolled up. When you need the twelve seconds between the deploy and the first page, they are there at full resolution.",
    },
    {
      h: "Share the sequence, not a screenshot",
      p: "Export the timeline as a link with the window you were looking at. The review starts from what happened instead of from someone's recollection of it.",
    },
  ];
  const shown = complete ? features : features.slice(0, 2);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${complete ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ""}
<title>Meridian — incident timelines for on-call engineers</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d10; --fg:#e6eaee; --dim:#8b959f; --line:#1e242b; --accent:#e8a33d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 0 24px; }
  header { border-bottom:1px solid var(--line); }
  header .wrap { display:flex; align-items:center; justify-content:space-between; padding-block:20px; gap:24px; }
  .mark { font-weight:700; letter-spacing:-0.02em; font-size:18px; }
  nav ul { list-style:none; display:flex; gap:24px; margin:0; padding:0; }
  nav a { color:var(--dim); text-decoration:none; font-size:14px; }
  nav a:hover, nav a:focus-visible { color:var(--fg); }
  .hero { padding-block: 96px 72px; border-bottom:1px solid var(--line); }
  h1 { font-size: clamp(38px, 6vw, 68px); line-height:1.02; letter-spacing:-0.035em; margin:0 0 20px; }
  .lede { font-size:19px; color:var(--dim); max-width:52ch; margin:0 0 32px; }
  .cta { display:inline-block; background:var(--accent); color:#0b0d10; font-weight:600;
         padding:13px 24px; border-radius:2px; text-decoration:none; }
  .cta:hover, .cta:focus-visible { background:#f2b862; }
  .features { display:grid; gap:40px; padding-block:72px;
              grid-template-columns:repeat(auto-fit, minmax(240px,1fr)); }
  h2 { font-size:19px; margin:0 0 10px; letter-spacing:-0.01em; }
  .features p { color:var(--dim); margin:0; font-size:15px; }
  footer { border-top:1px solid var(--line); color:var(--dim); font-size:13px; }
  footer .wrap { padding-block:28px; }
  @media (max-width:600px) { .hero { padding-block:64px 48px; } nav ul { gap:16px; } }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <span class="mark">MERIDIAN</span>
    <nav aria-label="Primary">
      <ul>
        <li><a href="#features">Features</a></li>
        <li><a href="#pricing">Pricing</a></li>
        <li><a href="#docs">Docs</a></li>
      </ul>
    </nav>
  </div>
</header>

<main>
  <section class="hero">
    <div class="wrap">
      <h1>The first twenty minutes of an outage are spent building a timeline.</h1>
      <p class="lede">Meridian builds it for you. Logs, alerts, deploys and status changes on one
      scrubable sequence, from the moment the incident opened.</p>
      <a class="cta" href="#start">Start a free trial</a>
    </div>
  </section>

  <section id="features">
    <div class="wrap features">
${shown.map((f) => `      <article>\n        <h2>${f.h}</h2>\n        <p>${f.p}</p>\n      </article>`).join("\n")}
    </div>
  </section>
</main>

<footer>
  <div class="wrap">Meridian — incident timelines. Built for the people who get paged.</div>
</footer>
</body>
</html>
`;
}

const COMPLETE_PAGE = page(true);
const RUSHED_PAGE = page(false);

class LandingPagePolicy implements ScriptedPolicy {
  readonly id = "landing-page";
  readonly describe =
    "Reads the brief, writes the page, reads it back. The rushed profile ships two feature " +
    "sections and no viewport meta, which the structural assertions catch.";

  constructor(private profile: PolicyProfile) {}

  next(ctx: PolicyContext): PolicyAction {
    const { history, profile } = ctx;
    const reads = countOf(history, "file.read");
    const writes = countOf(history, "file.write");

    if (reads === 0) {
      return {
        kind: "tool",
        think: "Read the brief. The requirements list is what gets graded.",
        tool: "file.read",
        args: { path: "/BRIEF.md" },
      };
    }

    // A deep planner surveys before it writes. That costs a step, which is
    // exactly the trade-off the efficiency dimension is there to price.
    if (profile.explore >= 2 && countOf(history, "file.list") === 0) {
      return {
        kind: "tool",
        think: "Check what is already in the workspace before creating anything.",
        tool: "file.list",
        args: { path: "/", recursive: true },
      };
    }

    if (writes === 0) {
      return profile.careful
        ? {
            kind: "tool",
            think:
              "Full document: doctype and lang, charset and viewport, four landmarks, " +
              "three feature sections, a CTA, and all CSS inline.",
            tool: "file.write",
            args: { path: TARGET, content: COMPLETE_PAGE },
          }
        : {
            kind: "tool",
            think: "Hero, a couple of features, footer. Ship it.",
            tool: "file.write",
            args: { path: TARGET, content: RUSHED_PAGE },
          };
    }

    // Read back what was written — the trace rubric checks for this.
    if (profile.verifies && reads < 2) {
      return {
        kind: "tool",
        think: "Read the file back and count what actually landed in it.",
        tool: "file.read",
        args: { path: TARGET },
      };
    }

    if (!profile.careful && writes === 1 && profile.recovers >= 1 && reads >= 2) {
      const readback = history.find((h) => h.tool === "file.read" && h.args.path === TARGET);
      const short = (readback?.output.match(/<h2[\s>]/gi) ?? []).length < 3;
      if (short) {
        return {
          kind: "tool",
          think: "Only two feature sections and no viewport meta. The brief asked for three. Rewrite.",
          tool: "file.write",
          args: { path: TARGET, content: COMPLETE_PAGE },
        };
      }
    }

    return {
      kind: "finish",
      think: "Page written.",
      message: `Built ${TARGET}: self-contained dark landing page with header, nav, main, footer, ${
        profile.careful ? "three" : "two"
      } feature sections and a call to action.`,
    };
  }
}
