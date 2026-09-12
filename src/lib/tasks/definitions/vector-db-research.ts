import type { GradingContext, TaskDefinition } from "../types";
import { contentCheck, fileExistsCheck } from "../types";
import { CORPUS } from "../corpus";
import type { PolicyAction, PolicyContext, PolicyProfile, ScriptedPolicy } from "@/lib/agents/policies/types";
import { countOf } from "@/lib/agents/policies/types";

/**
 * RESEARCH: OPEN-SOURCE VECTOR DATABASES
 *
 * Graded on citation discipline, not prose style. The corpus deliberately
 * contains a low-authority marketing page that contradicts the primary
 * documentation; citing it as support costs points, because discriminating
 * between sources is the skill being measured.
 */

const TARGET = "/report.md";

const SYSTEMS = [
  { label: "pgvector", test: /pgvector/i },
  { label: "Qdrant", test: /qdrant/i },
  { label: "Weaviate", test: /weaviate/i },
  { label: "Milvus", test: /milvus/i },
  { label: "Chroma", test: /chroma/i },
  { label: "LanceDB", test: /lance\s?db/i },
];

const LOW_AUTHORITY = CORPUS.filter((d) => d.authority < 0.4).map((d) => d.url);

function citedUrls(content: string): string[] {
  const found = new Set<string>();
  for (const doc of CORPUS) if (content.includes(doc.url)) found.add(doc.url);
  return [...found];
}

const BRIEF = `# Research brief

We are choosing a vector database for a retrieval layer over roughly 8 million
document chunks. We already run PostgreSQL. The team is four engineers with no
dedicated platform engineer.

Produce \`report.md\` with:

1. **Candidates** — at least four open-source systems, each with its licence and
   what it is actually good at.
2. **Trade-offs** — where each one stops being the right answer.
3. **Recommendation** — one system, for our situation specifically, with reasons
   that refer to the constraints above.
4. **Sources** — every claim traceable to a URL you actually fetched.

Cite by pasting the full URL. Prefer primary documentation over vendor blogs.
`;

export const vectorDbResearch: TaskDefinition = {
  task: {
    id: "task_vector_db_research",
    slug: "vector-db-research",
    title: "Recommend a vector database",
    brief: "Search, read, and produce a cited recommendation. The corpus contains a source that lies.",
    prompt: `Read /BRIEF.md, then research and write ${TARGET}.

Use web.search to find sources and web.fetch to read them in full. Snippets are not
enough to write from — fetch the documents you intend to cite.

You are graded on:
- covering at least four of the candidate systems with their licences,
- discussing where each one stops being the right answer,
- making one concrete recommendation tied to the stated constraints,
- citing full URLs you actually fetched, weighted by source quality.

At least one document in the corpus makes claims the primary documentation
contradicts. Citing it as support will cost you.`,
    category: "research",
    difficulty: "medium",
    limits: { timeLimitMs: 180_000, stepLimit: 28, budgetUsd: 0.5 },
    toolsAllowed: ["web.search", "web.fetch", "file.read", "file.write", "file.list"],
    successConditions: [
      "report.md exists with candidates, trade-offs, a recommendation and sources",
      "At least four candidate systems covered",
      "At least four distinct high-quality sources cited",
      "The low-authority source is not used as support",
    ],
    evaluation: {
      evaluators: ["rubric", "trace"],
      weights: {
        "rubric.score": 0.3,
        "sources.quality": 0.25,
        "rubric.coverage": 0.2,
        "quality.reasoning": 0.15,
        "efficiency.score": 0.1,
      },
      weightsOverridden: false,
    },
    seedFiles: [{ path: "/BRIEF.md", content: BRIEF, note: "The research brief" }],
    targetArtifact: { path: TARGET, kind: "markdown" },
  },

  environment() {
    return { "/BRIEF.md": BRIEF };
  },

  shellHooks() {
    return {};
  },

  tests: [],

  rubric: [
    fileExistsCheck("report-exists", "the report exists", TARGET, 1),
    contentCheck(
      "coverage",
      "covers at least four candidate systems",
      TARGET,
      (content) => {
        const hits = SYSTEMS.filter((s) => s.test.test(content));
        const score = Math.min(1, hits.length / 4);
        return {
          passed: hits.length >= 4,
          score,
          message: `${hits.length}/6 systems: ${hits.map((h) => h.label).join(", ") || "none"}`,
        };
      },
      3,
    ),
    contentCheck(
      "licences",
      "names the licences",
      TARGET,
      (content) => {
        const licences = (content.match(/\b(Apache\s*2|BSD-3|MIT|PostgreSQL licen[cs]e|AGPL)\b/gi) ?? []).length;
        const score = Math.min(1, licences / 3);
        return { passed: score >= 1, score, message: `${licences} licence mention(s)` };
      },
      1,
    ),
    contentCheck(
      "citations",
      "cites at least four distinct sources it could have read",
      TARGET,
      (content) => {
        const cited = citedUrls(content);
        const score = Math.min(1, cited.length / 4);
        return {
          passed: cited.length >= 4,
          score,
          message: `${cited.length} distinct source(s) cited`,
        };
      },
      2,
    ),
    contentCheck(
      "recommendation",
      "makes one concrete recommendation tied to the constraints",
      TARGET,
      (content) => {
        const hasSection = /##\s*.*recommend/i.test(content);
        const named = SYSTEMS.some((s) => {
          const idx = content.search(/##\s*.*recommend/i);
          return idx >= 0 && s.test.test(content.slice(idx, idx + 900));
        });
        const tiesToConstraints = /postgres|8\s?million|8m|four engineers|no dedicated|platform engineer/i.test(
          content,
        );
        const score = (hasSection ? 0.4 : 0) + (named ? 0.35 : 0) + (tiesToConstraints ? 0.25 : 0);
        return {
          passed: score >= 1,
          score,
          message: [
            hasSection ? "section present" : "no recommendation section",
            named ? "names a system" : "names no system",
            tiesToConstraints ? "refers to the constraints" : "generic reasoning",
          ].join("; "),
        };
      },
      3,
    ),
    contentCheck(
      "tradeoffs",
      "discusses where each option stops being right",
      TARGET,
      (content) => {
        const signals = (
          content.match(/\b(trade-?off|however|but |downside|limitation|caveat|stops being|not the right|avoid)\b/gi) ??
          []
        ).length;
        const score = Math.min(1, signals / 5);
        return { passed: score >= 1, score, message: `${signals} trade-off signal(s)` };
      },
      2,
    ),
    contentCheck(
      "source-discrimination",
      "does not cite the low-authority source as support",
      TARGET,
      (content) => {
        const usedBad = LOW_AUTHORITY.filter((u) => content.includes(u));
        if (usedBad.length === 0) {
          return { passed: true, score: 1, message: "clean" };
        }
        // Citing it while explicitly discrediting it is good practice, not a failure.
        const discredited = usedBad.every((u) => {
          const idx = content.indexOf(u);
          const around = content.slice(Math.max(0, idx - 300), idx + 300).toLowerCase();
          return /unreliable|marketing|no recall|not credible|discount|dubious|contradict|unsupported|ignore/.test(
            around,
          );
        });
        return {
          passed: discredited,
          score: discredited ? 1 : 0,
          message: discredited
            ? "cited the weak source but flagged it"
            : `cited ${usedBad.length} low-authority source(s) as support`,
        };
      },
      2,
    ),
    {
      // Measured against the real trace: did it actually fetch what it cited?
      id: "read-before-citing",
      name: "fetched the documents it cites",
      weight: 2,
      run(ctx: GradingContext) {
        if (!ctx.vfs.isFile(TARGET)) return { passed: false, score: 0, message: "no report" };
        const cited = citedUrls(ctx.vfs.read(TARGET));
        if (cited.length === 0) return { passed: false, score: 0, message: "nothing cited" };
        const fetched = new Set(
          ctx.events
            .filter((e) => e.tool === "web.fetch" && e.status === "ok")
            .map((e) => String(e.data?.url ?? "")),
        );
        const backed = cited.filter((u) => fetched.has(u));
        const score = backed.length / cited.length;
        return {
          passed: score >= 1,
          score,
          message: `${backed.length}/${cited.length} citations were actually fetched`,
        };
      },
    },
  ],

  policy(profile: PolicyProfile): ScriptedPolicy {
    return new VectorDbPolicy(profile);
  },
};

// ─── demo policy ────────────────────────────────────────────────────────────

const QUERIES = [
  "open source vector database comparison",
  "pgvector postgres hnsw ivfflat",
  "qdrant milvus weaviate architecture licence",
  "vector search benchmark recall methodology",
];

function buildReport(sources: { url: string; title: string }[], thorough: boolean): string {
  // A slot the agent never retrieved stays honestly empty rather than citing
  // a URL it did not see — which is precisely what the citation checks measure.
  const cite = (i: number) => (sources[i]?.url ? sources[i]!.url : "(not retrieved)");
  const list =
    sources
      .filter((s) => s.url)
      .map((s) => `- ${s.title} — ${s.url}`)
      .join("\n") || "- (no sources retrieved)";

  const head = `# Vector database recommendation

## Candidates

**pgvector** (PostgreSQL licence) — a Postgres extension, not a separate system.
Vectors live beside relational data, so there is no synchronisation problem and
filters are ordinary SQL in the same query. HNSW or IVFFlat indexes.
Source: ${cite(0)}

**Qdrant** (Apache 2.0, Rust) — filterable HNSW: the filter is applied during
graph traversal rather than after it, which is what keeps recall from collapsing
on selective filters. Scalar, product and binary quantisation.
Source: ${cite(1)}

**Weaviate** (BSD-3, Go) — module system that vectorises on write and at query
time, plus BM25/vector hybrid search with rank fusion. Hybrid wins on queries
carrying rare identifiers, where embeddings are weakest.
Source: ${cite(2)}

**Milvus** (Apache 2.0) — separated storage and compute over object storage with
a message queue on the write path. The broadest index support, including DISKANN
for datasets past RAM.
Source: ${cite(3)}
`;

  const extra = thorough
    ? `
**Chroma** (Apache 2.0) — in-process, four lines to a working collection.
Single-node is the supported path and metadata filtering is a post-filter, so
selective filters can under-return.

**LanceDB** (Apache 2.0) — embedded, object-storage-native, columnar format
built for random access. No server at all, which is close to unique for
serverless deployments.
`
    : "";

  const tradeoffs = `
## Trade-offs

pgvector's ceiling is PostgreSQL's: one primary for writes. Teams report comfort
into the tens of millions of vectors, beyond which dedicated engines with native
sharding are the better fit. At 8M we are inside that range, not near it.

Qdrant is memory-bound — the HNSW graph plus float32 vectors have to fit, which
is a real capacity planning exercise, though quantisation moves the line a long way.

Weaviate couples the database to a model choice through its vectoriser modules;
changing embedding model is a full reindex. The GraphQL-first surface is a taste
question worth checking with the team.

Milvus is the opposite trade: it scales furthest and costs the most to operate.
Several stateful dependencies stand up before the first vector is indexed. The
operators' guide puts the crossover below roughly 10M vectors — we are under it.

However, a caveat on all published comparisons: throughput without recall is
meaningless, because an ANN system can post any QPS number by returning worse
answers. Read benchmarks as a recall/QPS curve. Source: ${cite(4)}

I discounted one source entirely: ${LOW_AUTHORITY[0]} claims a 40x speedup and
that Postgres "cannot do vector search at all", with no recall numbers, no
hardware, and no configuration for the systems it beat. It is marketing, it
contradicts the primary documentation, and it is unreliable.

## Recommendation

**pgvector.**

The team already runs PostgreSQL and has four engineers and no dedicated platform
engineer. At 8 million chunks we are comfortably inside pgvector's operating
range, and the dominant cost here is not query latency — it is the operational
surface area of a second stateful system that four people have to keep alive.
Keeping vectors in Postgres also means filters are plain SQL against data that is
already consistent with the source of truth, with no synchronisation job to own.

Use HNSW rather than IVFFlat: it gives better recall at a given latency and does
not need representative data in the table before the index is built.

Revisit if we pass roughly 50M chunks or need per-tenant isolation, at which
point Qdrant is the natural next step — filtered search is its strength and
Apache 2.0 keeps the options open.

## Sources

${list}
`;

  return head + extra + tradeoffs;
}

class VectorDbPolicy implements ScriptedPolicy {
  readonly id = "vector-db-research";
  readonly describe =
    "Searches, fetches the primary docs, writes a cited report. The shallow profile writes " +
    "from search snippets without fetching, which the citation-backing check catches.";

  constructor(private profile: PolicyProfile) {}

  next(ctx: PolicyContext): PolicyAction {
    const { history, profile } = ctx;
    const searches = history.filter((h) => h.tool === "web.search");
    const fetches = history.filter((h) => h.tool === "web.fetch");
    const writes = countOf(history, "file.write");
    const reads = countOf(history, "file.read");

    if (reads === 0) {
      return {
        kind: "tool",
        think: "Read the brief. The constraints are what the recommendation has to answer to.",
        tool: "file.read",
        args: { path: "/BRIEF.md" },
      };
    }

    const wantSearches = profile.careful ? 2 : 1;
    if (searches.length < wantSearches) {
      return {
        kind: "tool",
        think: `Search for candidates (${searches.length + 1}/${wantSearches}).`,
        tool: "web.search",
        args: { query: QUERIES[searches.length] ?? QUERIES[0]!, limit: 6 },
      };
    }

    // Collect URLs the searches actually returned — the policy cites only these.
    const urls = collectUrls(history);
    const wantFetches = profile.careful ? Math.min(5, urls.length) : profile.explore >= 1 ? 2 : 0;

    if (fetches.length < wantFetches) {
      const next = urls.find((u) => !fetches.some((f) => f.args.url === u));
      if (next) {
        return {
          kind: "tool",
          think: "Fetch the full document rather than writing from a snippet.",
          tool: "web.fetch",
          args: { url: next },
        };
      }
    }

    if (writes === 0) {
      const fetchedDocs = fetches
        .filter((f) => f.ok)
        .map((f) => {
          const url = String(f.args.url ?? "");
          const doc = CORPUS.find((d) => d.url === url);
          return { url, title: doc?.title ?? url };
        });
      // Fall back to what search returned if nothing was fetched — which is
      // exactly the shallow behaviour the "fetched what it cites" check punishes.
      const sources = fetchedDocs.length
        ? fetchedDocs
        : urls.slice(0, 5).map((u) => ({ url: u, title: CORPUS.find((d) => d.url === u)?.title ?? u }));

      const ordered = orderForReport(sources);
      return {
        kind: "tool",
        think: profile.careful
          ? "Write the report: candidates with licences, trade-offs, one recommendation tied to the constraints, sources."
          : "Write it up from what the search returned.",
        tool: "file.write",
        args: { path: TARGET, content: buildReport(ordered, profile.careful) },
      };
    }

    return {
      kind: "finish",
      think: "Report written.",
      message: `Wrote ${TARGET}: ${profile.careful ? "six" : "four"} candidates with licences, trade-offs, and a recommendation of pgvector for an 8M-chunk workload on an existing Postgres with a four-person team.`,
    };
  }
}

function collectUrls(history: { tool: string; ok: boolean; output: string }[]): string[] {
  const urls: string[] = [];
  for (const h of history) {
    if (h.tool !== "web.search" || !h.ok) continue;
    for (const m of h.output.matchAll(/https?:\/\/[^\s)]+/g)) {
      const u = m[0];
      if (!urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}

/** Puts the canonical docs in the slots the report template cites by index. */
function orderForReport(sources: { url: string; title: string }[]): { url: string; title: string }[] {
  const want = [/pgvector/i, /qdrant/i, /weaviate/i, /milvus/i, /benchmark|ann-benchmarks/i];
  const ordered: { url: string; title: string }[] = [];
  const rest = [...sources];
  for (const pattern of want) {
    const idx = rest.findIndex((s) => pattern.test(s.url) || pattern.test(s.title));
    if (idx >= 0) ordered.push(...rest.splice(idx, 1));
    else ordered.push({ url: "", title: "" });
  }
  return [...ordered, ...rest].filter((s, i) => i < 5 || s.url !== "");
}

