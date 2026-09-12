import { describe, expect, it, beforeEach } from "vitest";
import { Vfs } from "@/lib/sandbox/vfs";
import { NodeVmExecutor } from "@/lib/sandbox/vm";
import { VirtualShell } from "@/lib/sandbox/shell";
import { OfflineCorpusBackend } from "@/lib/tools/web";
import { invoke, allTools, resolveCatalogue, TOOL_NAMES, getToolSpec } from "@/lib/tools/registry";
import type { ToolContext } from "@/lib/tools/types";

const executor = new NodeVmExecutor();

function makeContext(seed: Record<string, string> = {}, budget = 1): ToolContext {
  const vfs = Vfs.fromSnapshot(seed);
  return {
    vfs,
    shell: new VirtualShell({ vfs, executor }),
    executor,
    signal: new AbortController().signal,
    budgetRemaining: budget,
    search: new OfflineCorpusBackend(),
  };
}

describe("tool registry", () => {
  it("exposes a spec for every registered tool", () => {
    for (const name of TOOL_NAMES) {
      const spec = getToolSpec(name);
      expect(spec, name).toBeDefined();
      expect(spec!.description.length).toBeGreaterThan(20);
      expect(spec!.timeoutMs).toBeGreaterThan(0);
    }
    expect(allTools()).toHaveLength(TOOL_NAMES.length);
  });

  it("intersects the task allowlist with the agent's own tools", () => {
    const catalogue = resolveCatalogue(
      ["file.read", "file.write", "shell.exec"],
      ["file.read", "web.search"],
    );
    expect(catalogue.map((t) => t.name)).toEqual(["file.read"]);
  });

  it("returns an empty catalogue when there is no overlap", () => {
    expect(resolveCatalogue(["file.read"], ["web.search"])).toEqual([]);
  });
});

describe("invoke", () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = makeContext({ "/README.md": "hello", "/src/a.js": "module.exports = 1;" });
  });

  it("rejects an unknown tool with a usable error rather than throwing", async () => {
    const result = await invoke("does.not.exist", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.invalidArguments).toBe(true);
    expect(result.error).toMatch(/Unknown tool/);
    expect(result.error).toMatch(/file.read/);
  });

  it("turns a schema violation into a tool error the agent can read", async () => {
    const result = await invoke("file.read", { path: 123 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.invalidArguments).toBe(true);
    expect(result.error).toMatch(/Invalid arguments for file.read/);
    expect(result.error).toMatch(/Expected: path: string/);
  });

  it("treats missing arguments as a recoverable error", async () => {
    const result = await invoke("file.write", { path: "/x.txt" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.invalidArguments).toBe(true);
  });

  it("handles a null argument object", async () => {
    const result = await invoke("file.list", null, ctx);
    expect(result.ok).toBe(true);
  });

  it("refuses a tool that would exceed the remaining budget", async () => {
    const broke = makeContext({}, 0);
    const result = await invoke("web.search", { query: "vector database" }, broke);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient budget/);
    expect(result.invalidArguments).toBe(false);
  });

  it("charges the declared cost on a successful call", async () => {
    const result = await invoke("web.search", { query: "vector database" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(getToolSpec("web.search")!.cost);
  });

  it("reads and writes files", async () => {
    expect((await invoke("file.read", { path: "/README.md" }, ctx)).output).toBe("hello");
    const write = await invoke("file.write", { path: "/out/new.txt", content: "written" }, ctx);
    expect(write.ok).toBe(true);
    expect(ctx.vfs.read("/out/new.txt")).toBe("written");
    expect(write.meta?.kind).toBe("created");
  });

  it("surfaces a filesystem error as a tool error", async () => {
    const result = await invoke("file.read", { path: "/missing.txt" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });

  it("rejects path traversal", async () => {
    const result = await invoke("file.read", { path: "../../etc/passwd" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes the workspace root/);
  });

  it("reads a line range", async () => {
    ctx.vfs.write("/lines.txt", "one\ntwo\nthree\nfour");
    const result = await invoke("file.read", { path: "/lines.txt", startLine: 2, endLine: 3 }, ctx);
    expect(result.output).toContain("two");
    expect(result.output).toContain("three");
    expect(result.output).not.toContain("four");
  });

  it("runs shell commands and reports a non-zero exit as an error", async () => {
    const ok = await invoke("shell.exec", { command: "ls /src" }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("a.js");

    const bad = await invoke("shell.exec", { command: "cat /nope" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.meta?.exitCode).toBe(1);
  });

  it("executes code and returns its output", async () => {
    const result = await invoke(
      "code.run",
      { source: `console.log("sum", 1 + 2); module.exports = 3;` },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("sum 3");
    expect(ctx.vfs.isFile("/scratch/run.js")).toBe(true);
  });

  it("rejects code.run given both source and path", async () => {
    const result = await invoke("code.run", { source: "1", path: "/a.js" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exactly one/);
  });

  it("rejects code.run given neither", async () => {
    const result = await invoke("code.run", {}, ctx);
    expect(result.ok).toBe(false);
  });

  it("reports a code failure without throwing", async () => {
    const result = await invoke("code.run", { source: `throw new Error("nope");` }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nope/);
  });

  it("badges offline corpus results with their provenance", async () => {
    const result = await invoke("web.search", { query: "vector database comparison" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.provenance).toBe("offline-corpus");
    expect(result.output).toMatch(/Bundled corpus/);
  });

  it("fetches a document the corpus actually contains", async () => {
    const search = await invoke("web.search", { query: "pgvector postgres" }, ctx);
    const url = (search.meta?.urls as string[])[0]!;
    const fetched = await invoke("web.fetch", { url }, ctx);
    expect(fetched.ok).toBe(true);
    expect(fetched.provenance).toBe("offline-corpus");
    expect(fetched.output).toContain("SOURCE:");
  });

  it("explains why an unknown URL cannot be fetched offline", async () => {
    const result = await invoke("web.fetch", { url: "https://example.com/nope" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in the bundled corpus/);
  });

  it("rejects a non-http url", async () => {
    const result = await invoke("web.fetch", { url: "file:///etc/passwd" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.invalidArguments).toBe(true);
  });

  it("truncates enormous tool output", async () => {
    ctx.vfs.write("/big.txt", "x".repeat(60_000));
    const result = await invoke("file.read", { path: "/big.txt" }, ctx);
    expect(result.output.length).toBeLessThan(45_000);
  });

  it("records a duration for every call", async () => {
    const result = await invoke("file.list", {}, ctx);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("offline corpus retrieval", () => {
  const backend = new OfflineCorpusBackend();

  it("finds relevant documents for a real query", async () => {
    const hits = await backend.search("open source vector database comparison", 5);
    expect(hits.length).toBeGreaterThan(2);
    expect(hits.some((h) => /pgvector|qdrant|milvus/i.test(h.title))).toBe(true);
  });

  it("ranks by relevance, not insertion order", async () => {
    const hits = await backend.search("rate limiting token bucket", 3);
    expect(hits[0]!.title).toMatch(/rate limiting/i);
  });

  it("returns nothing for a query with no matching terms", async () => {
    expect(await backend.search("zzzzqqqq", 5)).toEqual([]);
  });

  it("exposes authority so source quality can be measured", async () => {
    const hits = await backend.search("vector database benchmark", 8);
    const authorities = hits.map((h) => h.authority).filter((a): a is number => a !== undefined);
    expect(authorities.length).toBeGreaterThan(0);
    // The corpus deliberately contains low-authority marketing alongside docs.
    expect(Math.min(...authorities)).toBeLessThan(0.5);
    expect(Math.max(...authorities)).toBeGreaterThan(0.85);
  });
});
