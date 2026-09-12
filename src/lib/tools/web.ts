import { z } from "zod";
import { defineTool } from "./types";
import type { SearchBackend, SearchHit } from "./types";
import { CORPUS, fetchFromCorpus, searchCorpus, snippetFor } from "@/lib/tasks/corpus";

/**
 * Search backends.
 *
 * The offline backend is the default and it is honest about being offline: the
 * tool result carries `provenance: "offline-corpus"`, which the UI renders as
 * an OFFLINE CORPUS badge on the tool card and the match detail page. Nothing
 * claims to have reached the live web unless it actually did.
 */

export class OfflineCorpusBackend implements SearchBackend {
  readonly id = "offline-corpus";
  readonly provenance = "offline-corpus" as const;
  readonly label = `Bundled corpus (${CORPUS.length} documents)`;

  async search(query: string, limit: number): Promise<SearchHit[]> {
    return searchCorpus(query, limit).map((doc) => ({
      title: doc.title,
      url: doc.url,
      snippet: snippetFor(doc, query),
      authority: doc.authority,
      publishedAt: doc.publishedAt,
    }));
  }

  async fetch(url: string) {
    const doc = fetchFromCorpus(url);
    if (!doc) return null;
    return { title: doc.title, url: doc.url, content: doc.body };
  }
}

/** Tavily-backed live search. Only constructed when a key is present. */
export class TavilyBackend implements SearchBackend {
  readonly id = "tavily";
  readonly provenance = "live-web" as const;
  readonly label = "Tavily (live web)";

  constructor(private apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: Math.min(limit, 10),
        search_depth: "basic",
      }),
    });
    if (!res.ok) throw new Error(`search provider returned ${res.status}`);
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string; score?: number }[];
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? r.url ?? "untitled",
      url: r.url ?? "",
      snippet: (r.content ?? "").slice(0, 400),
      authority: typeof r.score === "number" ? Math.min(1, Math.max(0, r.score)) : undefined,
    }));
  }

  async fetch(url: string) {
    const res = await fetch(url, {
      headers: { "user-agent": "ai-agent-arena/0.1 (+research task fetcher)" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? url;
    const content = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20_000);
    return { title, url, content };
  }
}

export function createSearchBackend(env: Record<string, string | undefined> = process.env): SearchBackend {
  const key = env.TAVILY_API_KEY?.trim();
  return key ? new TavilyBackend(key) : new OfflineCorpusBackend();
}

// ─── tools ──────────────────────────────────────────────────────────────────

const webSearch = defineTool({
  spec: {
    name: "web.search",
    title: "Web search",
    description:
      "Search for documents relevant to a query. Returns titles, URLs and snippets. " +
      "Use web.fetch on a URL to read the full document.",
    permission: "network",
    timeoutMs: 10_000,
    cost: 0.002,
    parameters: {
      query: { type: "string", description: "Search query", required: true },
      limit: { type: "number", description: "Max results (1–10, default 5)", required: false },
    },
  },
  schema: z.object({
    query: z.string().min(2, "query is required").max(400),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  async execute(args, ctx) {
    try {
      const hits = await ctx.search.search(args.query, args.limit ?? 5);
      if (hits.length === 0) {
        return {
          ok: true,
          output: `No results for "${args.query}".`,
          error: null,
          provenance: ctx.search.provenance,
          meta: { count: 0, backend: ctx.search.id },
        };
      }
      const body = hits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.title}\n    ${h.url}${h.publishedAt ? `  (${h.publishedAt})` : ""}\n    ${h.snippet}`,
        )
        .join("\n\n");
      return {
        ok: true,
        output: `${hits.length} result(s) from ${ctx.search.label}:\n\n${body}`,
        error: null,
        provenance: ctx.search.provenance,
        meta: { count: hits.length, backend: ctx.search.id, urls: hits.map((h) => h.url) },
      };
    } catch (e) {
      return {
        ok: false,
        output: "",
        error: `search failed: ${e instanceof Error ? e.message : String(e)}`,
        provenance: ctx.search.provenance,
      };
    }
  },
});

const webFetch = defineTool({
  spec: {
    name: "web.fetch",
    title: "Fetch URL",
    description: "Retrieve the full text of a document by URL, as returned by web.search.",
    permission: "network",
    timeoutMs: 12_000,
    cost: 0.001,
    parameters: {
      url: { type: "string", description: "Document URL", required: true },
    },
  },
  schema: z.object({
    url: z
      .string()
      .min(4)
      .max(500)
      .refine((u) => /^https?:\/\//i.test(u), "url must start with http:// or https://"),
  }),
  async execute(args, ctx) {
    try {
      const doc = await ctx.search.fetch(args.url);
      if (!doc) {
        return {
          ok: false,
          output: "",
          error:
            ctx.search.provenance === "offline-corpus"
              ? `${args.url} is not in the bundled corpus. Use web.search first and fetch a URL it returned.`
              : `could not retrieve ${args.url}`,
          provenance: ctx.search.provenance,
        };
      }
      return {
        ok: true,
        output: `# ${doc.title}\nSOURCE: ${doc.url}\n\n${doc.content}`,
        error: null,
        provenance: ctx.search.provenance,
        meta: { url: doc.url, bytes: doc.content.length },
      };
    } catch (e) {
      return {
        ok: false,
        output: "",
        error: `fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        provenance: ctx.search.provenance,
      };
    }
  },
});

export const webTools = [webSearch, webFetch];
