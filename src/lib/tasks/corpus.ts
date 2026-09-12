/**
 * Offline document corpus.
 *
 * Research tasks need something real to read. Rather than pretend to hit the
 * live web, the arena ships a bundled corpus of documents and runs a real
 * retrieval function over it. Every result carries `provenance:
 * "offline-corpus"` and the UI badges it OFFLINE CORPUS on the tool card.
 *
 * The corpus deliberately contains a mix of quality: primary documentation,
 * neutral comparisons, and low-authority marketing pages with claims the other
 * documents contradict. Research tasks are graded partly on whether an agent
 * cites the good sources and avoids repeating the bad ones — which is only a
 * meaningful test if the bad ones are actually there.
 */

export interface CorpusDocument {
  url: string;
  title: string;
  site: string;
  publishedAt: string;
  /** 0–1 editorial authority. Primary docs score high, vendor blogs low. */
  authority: number;
  tags: string[];
  body: string;
}

export const CORPUS: CorpusDocument[] = [
  {
    url: "https://docs.postgresql.example/pgvector/overview",
    title: "pgvector: vector similarity search for PostgreSQL",
    site: "postgresql docs",
    publishedAt: "2025-02-11",
    authority: 0.95,
    tags: ["vector database", "pgvector", "postgres", "open source", "embeddings"],
    body: `pgvector is an open-source PostgreSQL extension (PostgreSQL licence) that adds a
\`vector\` column type plus exact and approximate nearest-neighbour search.

Index types: IVFFlat and HNSW. HNSW gives better recall at a given latency and does not
require a pre-populated table to build, at the cost of slower build time and higher
memory. IVFFlat builds faster and uses less memory but needs representative data present
before the index is created.

Distance operators: L2 (<->), inner product (<#>), cosine (<=>), and L1 (<+>) from 0.7.

Operational profile: because it is an extension, vectors live in the same database as
relational data. That removes a synchronisation problem — no separate store to keep in
step with your source of truth — and lets you filter with ordinary SQL WHERE clauses in
the same query as the similarity search. The trade-off is that scaling is PostgreSQL's
scaling: a single primary for writes, read replicas for reads.

Practical ceiling: teams report comfortable operation into the tens of millions of
vectors on a well-provisioned instance. Beyond that, dedicated engines with native
sharding are usually the better fit.

Dimension limit: 2000 for indexed columns, 16000 for stored columns.`,
  },
  {
    url: "https://docs.qdrant.example/concepts/architecture",
    title: "Qdrant architecture: collections, shards and quantisation",
    site: "qdrant docs",
    publishedAt: "2025-04-02",
    authority: 0.93,
    tags: ["vector database", "qdrant", "rust", "open source", "hnsw", "quantization"],
    body: `Qdrant is an open-source vector search engine written in Rust, licensed Apache 2.0.

Storage: collections are split into shards; each shard holds a segment set with an HNSW
graph. Payloads (arbitrary JSON attached to a vector) are indexed separately, which is
what makes Qdrant's filtered search fast — the filter is applied during graph traversal
rather than as a post-processing step over results. Post-filtering is the naive approach
and degrades recall badly at high filter selectivity; Qdrant's filterable HNSW avoids it.

Quantisation: scalar (int8), product, and binary. Binary quantisation gives roughly 32x
memory reduction with a rescoring pass to recover accuracy; it works well for
high-dimensional embeddings from modern models and poorly for low-dimensional ones.

Distribution: native sharding and replication with Raft for cluster metadata consensus.

Operational note: memory is the binding constraint. An HNSW graph over N vectors of
dimension d in float32 needs roughly N × d × 4 bytes for the vectors plus graph overhead
of about N × M × 8 bytes where M is the connectivity parameter (default 16).`,
  },
  {
    url: "https://docs.weaviate.example/architecture/storage",
    title: "Weaviate: modules, hybrid search and the LSM store",
    site: "weaviate docs",
    publishedAt: "2025-01-28",
    authority: 0.9,
    tags: ["vector database", "weaviate", "go", "open source", "hybrid search", "bm25"],
    body: `Weaviate is an open-source vector database written in Go, licensed BSD-3-Clause.

Its distinguishing feature is a module system: vectorisation can be delegated to a
module (text2vec-*, multi2vec-*) so the database itself produces embeddings on write and
at query time, rather than requiring the application to do it. That reduces application
code but couples your database to a model choice, and re-vectorising after a model change
is a full reindex.

Hybrid search combines BM25 keyword scoring with vector similarity using reciprocal rank
fusion. In practice hybrid retrieval outperforms pure vector search on queries containing
rare proper nouns, identifiers, or exact numbers — precisely the queries where embeddings
are weakest.

Storage is an LSM tree, so write throughput is high and compaction is a background cost
you must provision for.

GraphQL is the primary query interface, with REST and gRPC alternatives. Teams that
dislike GraphQL should weigh that, as the GraphQL surface is the most complete.`,
  },
  {
    url: "https://docs.milvus.example/overview/architecture",
    title: "Milvus: a distributed vector database with separated storage and compute",
    site: "milvus docs",
    publishedAt: "2025-03-14",
    authority: 0.91,
    tags: ["vector database", "milvus", "open source", "distributed", "kubernetes"],
    body: `Milvus is an open-source vector database under the Apache 2.0 licence, a graduated
LF AI & Data Foundation project.

Architecture: four separated layers — access, coordinator, worker nodes, and object
storage. Components scale independently and state lives in object storage (S3, MinIO)
with a message queue (Pulsar or Kafka) for the write path.

That design is the reason to choose Milvus and the reason not to. It scales to billions
of vectors and separates read from write capacity cleanly. It also means a production
deployment has several stateful dependencies before you index a single vector. Milvus
Lite exists for local development and small single-process deployments, and Zilliz offers
a managed service.

Index support is the broadest of the major engines: FLAT, IVF_FLAT, IVF_SQ8, IVF_PQ,
HNSW, SCANN, DISKANN. DISKANN is the differentiator for datasets that exceed RAM — it
keeps the graph on SSD with a memory-resident compressed representation.

Rule of thumb from the operators' guide: below ~10M vectors the operational cost of
Milvus is hard to justify against simpler options; above ~100M it is hard to avoid.`,
  },
  {
    url: "https://docs.chroma.example/getting-started",
    title: "Chroma: an embedding database for prototyping",
    site: "chroma docs",
    publishedAt: "2025-02-20",
    authority: 0.82,
    tags: ["vector database", "chroma", "python", "open source", "prototyping"],
    body: `Chroma is an open-source embedding database (Apache 2.0) built for developer
ergonomics. \`pip install chromadb\` and four lines of Python gets you a working
collection with persistence to disk.

It runs in-process or as a server. The in-process mode is genuinely convenient for
notebooks and tests, and is the main reason Chroma appears in so many tutorials.

Honest positioning from the maintainers: Chroma targets the prototype-to-early-production
range. Single-node operation is the supported path; distributed Chroma is newer and less
battle-tested than the equivalent in Milvus or Qdrant. Teams routinely start on Chroma
and migrate once they pass a few million vectors or need multi-tenant isolation.

Index: HNSW via hnswlib, with metadata filtering applied as a post-filter — which means
highly selective filters can return fewer results than requested.`,
  },
  {
    url: "https://docs.lancedb.example/concepts/format",
    title: "LanceDB and the Lance columnar format",
    site: "lancedb docs",
    publishedAt: "2025-05-06",
    authority: 0.86,
    tags: ["vector database", "lancedb", "rust", "open source", "columnar", "embedded"],
    body: `LanceDB is an open-source (Apache 2.0) embedded vector database built on Lance, a
columnar format designed for random access — the property Parquet lacks and that vector
workloads need.

Embedded means no server: it links into your process and reads directly from local disk
or object storage. Zero operational footprint is the headline, and for serverless
deployments where you cannot keep a database process alive it is close to unique.

Because storage is object-storage-native, you can point several readers at one dataset in
S3 without a coordinator. Writes use optimistic concurrency with versioned manifests, and
the versioning gives you time travel over the dataset for free.

Index: IVF_PQ, with an HNSW option. Query latency from cold object storage is dominated
by network round trips; a local SSD cache is effectively required for interactive use.`,
  },
  {
    url: "https://vectorhype.example/blog/fastest-vector-db-2025",
    title: "We benchmarked every vector database and ours won",
    site: "vectorhype blog",
    publishedAt: "2025-06-01",
    authority: 0.18,
    tags: ["vector database", "benchmark", "marketing"],
    body: `Our engine is 40x faster than every competitor and scales infinitely with no
tuning required. Postgres cannot do vector search at all. HNSW is obsolete. Anyone still
using an open-source vector database in 2025 is wasting engineering time.

We ran our benchmark on a 10,000 vector dataset with a single client thread and did not
publish recall numbers, the hardware, or the configuration of the competing systems.

Sign up for our managed tier to get started.`,
  },
  {
    url: "https://ann-benchmarks.example/methodology",
    title: "ANN-Benchmarks: how to read a vector search benchmark",
    site: "ann-benchmarks",
    publishedAt: "2024-11-19",
    authority: 0.94,
    tags: ["vector database", "benchmark", "recall", "methodology", "hnsw"],
    body: `Any vector search benchmark that reports throughput without recall is meaningless.
Approximate nearest-neighbour search trades accuracy for speed by construction, so a
system can post an arbitrarily large QPS number by returning worse answers.

Read benchmarks as a curve, not a number: recall@10 on the x-axis, queries per second on
the y-axis. A system is better than another only if its curve is above it across the
recall range you care about.

Also check: dataset size and dimensionality (results do not transfer between them),
whether the index build time is included, whether filtering was part of the workload,
client concurrency, and whether the comparison systems were tuned by someone with an
interest in them losing.

Published vendor benchmarks fail at least one of these checks roughly as often as not.`,
  },
  {
    url: "https://engineering.example/rate-limiting-algorithms",
    title: "Four rate limiting algorithms and when each one is wrong",
    site: "engineering journal",
    publishedAt: "2025-01-09",
    authority: 0.92,
    tags: ["rate limiting", "token bucket", "leaky bucket", "sliding window", "algorithms"],
    body: `**Fixed window.** Count requests per discrete interval; reset at the boundary. One
counter per key, trivially cheap. Its failure is the boundary burst: a client can send a
full quota at 0:59 and another at 1:00, achieving 2x the intended rate for one second.

**Sliding window log.** Store a timestamp per request and count those inside the window.
Exact, and the memory cost is proportional to the request rate — which is unacceptable at
scale for the abusive clients you most want to limit.

**Sliding window counter.** Interpolate between the previous and current fixed windows.
Approximates the log with two counters. Error is bounded and small for smooth traffic;
it under-counts bursts that land just after a boundary.

**Token bucket.** Tokens accrue at a fixed rate to a cap; each request spends one. Two
numbers per key (token count, last refill time) and it permits bursts up to the bucket
size, which usually matches what you actually want from an API: sustained rate limiting
that tolerates a legitimate burst.

**Leaky bucket** is token bucket's dual: it smooths output to a constant rate rather than
permitting bursts. Choose it when the thing downstream cannot absorb a burst at all.

**GCRA** (generic cell rate algorithm) achieves token-bucket behaviour with a single
stored value — the theoretical arrival time — which is why Redis-backed limiters favour
it. It is the correct default for a distributed limiter.

Distributed caveat: any of these implemented as read-modify-write against a shared store
is racy. Use an atomic server-side operation (a Lua script in Redis, or INCR with
expiry) or accept that your limit is approximate under concurrency.`,
  },
  {
    url: "https://docs.redis.example/patterns/rate-limiter",
    title: "Implementing a distributed rate limiter in Redis",
    site: "redis docs",
    publishedAt: "2024-09-30",
    authority: 0.9,
    tags: ["rate limiting", "redis", "distributed", "lua", "token bucket"],
    body: `The naive pattern — GET the counter, compare, SET it back — has a race between the
read and the write. Under concurrency it admits more requests than the limit allows, and
the error grows with the number of clients.

Two correct patterns:

1. \`INCR\` with \`EXPIRE\` on first increment. Atomic, one round trip with a pipeline.
   Implements a fixed window, inheriting the boundary-burst problem.

2. A Lua script implementing GCRA or token bucket. Redis executes the script atomically,
   so the read-modify-write is safe. Stores one hash per key; returns the retry-after
   delay so the caller can send a correct \`Retry-After\` header.

Always set a TTL. A rate limiter without expiry is a memory leak with a counter attached.

Return \`429\` with \`Retry-After\` and the \`RateLimit-*\` headers from the IETF draft.
Clients that cannot see their remaining quota will retry immediately and make the problem
worse.`,
  },
  {
    url: "https://scalehype.example/blog/rate-limits-are-easy",
    title: "Rate limiting is a solved problem — just use a counter",
    site: "scalehype blog",
    publishedAt: "2025-03-22",
    authority: 0.2,
    tags: ["rate limiting", "marketing", "counter"],
    body: `Just keep a counter in memory and reset it every minute. Distributed systems
people overcomplicate this. You do not need Redis, you do not need atomic operations, and
race conditions are not real at the scale most companies operate at.

If two servers disagree about the count, that is fine — it averages out.

(No discussion of boundary bursts, per-instance state, or what happens when the process
restarts.)`,
  },
  {
    url: "https://ietf.example/draft-ratelimit-headers",
    title: "RateLimit header fields for HTTP (draft)",
    site: "ietf draft",
    publishedAt: "2025-04-18",
    authority: 0.88,
    tags: ["rate limiting", "http", "headers", "standards", "429"],
    body: `Defines \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\` so a
server can communicate quota state to clients in a machine-readable way.

\`RateLimit-Reset\` is a delta in seconds, not a timestamp — this avoids clock skew
between client and server, which was the main interoperability failure of the earlier
X-RateLimit conventions.

A 429 response SHOULD include \`Retry-After\`. Servers SHOULD NOT return 503 for quota
exhaustion: 503 signals server unavailability and triggers different client retry
behaviour, usually more aggressive, which is the opposite of the intent.`,
  },
  {
    url: "https://docs.owasp.example/auth/session-tokens",
    title: "Session token handling: expiry, rotation and constant-time comparison",
    site: "owasp guide",
    publishedAt: "2024-12-03",
    authority: 0.93,
    tags: ["auth", "security", "tokens", "session", "timing attack"],
    body: `Compare secrets with a constant-time function. \`a === b\` on strings short-circuits
at the first differing byte, and that timing difference is measurable across a network
with enough samples.

Always validate expiry server-side against the server clock. A token that carries its own
expiry claim is only trustworthy if the signature covering that claim is verified first —
checking expiry before signature is a classic ordering bug.

Reject tokens with a missing, empty, or structurally invalid payload before doing any
other work, and return the same generic error for every failure mode. Distinguishing
"unknown user" from "wrong password" in the response is a user-enumeration vector.

Rotate the session identifier on privilege change (login, elevation). Failing to do so is
session fixation.`,
  },
  {
    url: "https://engineering.example/csv-data-quality",
    title: "Cleaning real-world CSV: nulls, duplicates and the numbers that lie",
    site: "engineering journal",
    publishedAt: "2025-02-02",
    authority: 0.85,
    tags: ["data", "csv", "analysis", "cleaning", "statistics"],
    body: `Three failure modes account for most wrong answers computed from real CSV exports.

**Empty is not zero.** A blank cell in a numeric column usually means "not recorded".
Coercing it to 0 drags every mean toward zero and silently corrupts sums. Decide
explicitly: exclude, or impute and say so.

**Duplicate rows.** Exports that join across tables duplicate the left-hand side. Check
for a unique key and deduplicate before aggregating, or every per-entity total is wrong
by the fan-out factor.

**Type drift within a column.** \`1,234\` with a thousands separator, \`1.2k\`, \`N/A\`,
and a stray header repeated mid-file all parse as strings. A parser that skips
unparseable values without counting them hides the problem; count and report them.

Always report n alongside any aggregate. A mean over 3 surviving rows out of 400 is not a
mean, it is a coincidence.`,
  },
];

// ─── retrieval ──────────────────────────────────────────────────────────────

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "is", "are", "what",
  "which", "best", "top", "how", "with", "vs", "versus", "about", "it", "that", "this",
]);

function terms(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Deterministic scoring over the corpus: term frequency in the body, weighted
 * boosts for title and tag hits, then a small authority tiebreak. Real
 * retrieval over real documents — just a small, local index.
 */
export function searchCorpus(query: string, limit = 5): CorpusDocument[] {
  const q = terms(query);
  if (q.length === 0) return [];

  const scored = CORPUS.map((doc) => {
    const haystack = doc.body.toLowerCase();
    const title = doc.title.toLowerCase();
    const tags = doc.tags.join(" ").toLowerCase();
    let score = 0;
    for (const term of q) {
      const inBody = haystack.split(term).length - 1;
      if (inBody > 0) score += 1 + Math.log(inBody);
      if (title.includes(term)) score += 3;
      if (tags.includes(term)) score += 2.5;
    }
    // Phrase bonus keeps multi-word queries from behaving like bags of words.
    if (q.length > 1 && haystack.includes(q.join(" "))) score += 4;
    return { doc, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.authority - a.doc.authority);

  return scored.slice(0, limit).map((s) => s.doc);
}

export function fetchFromCorpus(url: string): CorpusDocument | null {
  const normalised = url.trim().replace(/\/+$/, "");
  return CORPUS.find((d) => d.url.replace(/\/+$/, "") === normalised) ?? null;
}

export function snippetFor(doc: CorpusDocument, query: string, length = 220): string {
  const q = terms(query);
  const body = doc.body.replace(/\s+/g, " ");
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of q) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (at === -1 || idx < at)) at = idx;
  }
  const start = at <= 0 ? 0 : Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + body.slice(start, start + length).trim() + (body.length > start + length ? "…" : "");
}
