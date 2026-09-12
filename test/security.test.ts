import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Vfs } from "@/lib/sandbox/vfs";
import { NodeVmExecutor } from "@/lib/sandbox/vm";
import { VirtualShell } from "@/lib/sandbox/shell";
import { OfflineCorpusBackend } from "@/lib/tools/web";
import { invoke } from "@/lib/tools/registry";
import { providerStatuses } from "@/lib/agents/providers/registry";
import type { ToolContext } from "@/lib/tools/types";

/**
 * Regression guards for the security posture in docs/ARCHITECTURE.md §10.
 * These are the properties that must not quietly erode.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const SOURCES = sourceFiles("src");

describe("no host process execution anywhere", () => {
  it("never imports child_process", () => {
    const offenders = SOURCES.filter((file) => {
      const text = readFileSync(file, "utf8");
      return /from\s+["']node:child_process["']|require\(\s*["']child_process["']\s*\)/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("never spawns, execs or forks", () => {
    const offenders = SOURCES.filter((file) =>
      /\b(spawnSync|execSync|execFileSync|spawn\(|execFile\(|\bfork\()/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("touches the real filesystem only in the persistence driver", () => {
    const offenders = SOURCES.filter((file) => {
      if (file.includes("store/file-store.ts")) return false;
      return /from\s+["']node:fs["']/.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("uses node:vm only in the sandbox executor", () => {
    const offenders = SOURCES.filter(
      (file) => !file.includes("sandbox/vm.ts") && /from\s+["']node:vm["']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("secrets are never exposed to the client", () => {
  it("reports configuration as a boolean and nothing else", () => {
    for (const status of providerStatuses()) {
      const serialised = JSON.stringify(status);
      expect(typeof status.configured).toBe("boolean");
      // The env var NAME is fine to expose; a value is not.
      expect(serialised).not.toMatch(/sk-|api[_-]?key["']?\s*:\s*["'][^"']{8,}/i);
      expect(Object.keys(status)).toEqual(["id", "label", "configured", "models", "envVar"]);
    }
  });

  it("never reads a provider key outside a server-only module", () => {
    const offenders = SOURCES.filter((file) => {
      if (file.includes("agents/providers/")) return false;
      return /process\.env\.(ANTHROPIC|OPENAI|GOOGLE|TAVILY)_API_KEY/.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("keeps no provider key in any client component", () => {
    const clientFiles = SOURCES.filter((file) => readFileSync(file, "utf8").startsWith('"use client"'));
    expect(clientFiles.length).toBeGreaterThan(0);
    for (const file of clientFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.env\.[A-Z_]*API_KEY/);
    }
  });
});

describe("untrusted model output", () => {
  const executor = new NodeVmExecutor();

  function ctx(seed: Record<string, string> = {}): ToolContext {
    const vfs = Vfs.fromSnapshot(seed);
    return {
      vfs,
      shell: new VirtualShell({ vfs, executor }),
      executor,
      signal: new AbortController().signal,
      budgetRemaining: 10,
      search: new OfflineCorpusBackend(),
    };
  }

  it("rejects every shape of path traversal", async () => {
    const attempts = [
      "../../../etc/passwd",
      "/../../etc/passwd",
      "a/../../../../etc/shadow",
      "./././../../root/.ssh/id_rsa",
    ];
    for (const path of attempts) {
      const result = await invoke("file.read", { path }, ctx());
      expect(result.ok, path).toBe(false);
      expect(result.error, path).toMatch(/escapes the workspace root|ENOENT/);
    }
  });

  it("rejects a null byte in a path", async () => {
    const result = await invoke("file.write", { path: `a${String.fromCharCode(0)}b`, content: "x" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("cannot reach the host through the shell", async () => {
    const attempts = [
      "cat /etc/passwd",
      "bash -c 'id'",
      "sh -c 'ls /'",
      "node -e 'require(\"fs\")'",
      "curl https://example.com",
      "wget http://x",
      "rm -rf /",
      "python3 -c 'import os'",
    ];
    for (const command of attempts) {
      const result = await invoke("shell.exec", { command }, ctx());
      expect(result.ok, command).toBe(false);
    }
  });

  it("cannot reach the host through executed code", async () => {
    const probes = [
      `module.exports = typeof process;`,
      `module.exports = typeof require("fs");`,
      `module.exports = typeof globalThis.fetch;`,
      `module.exports = typeof Buffer;`,
      `module.exports = typeof globalThis.process;`,
    ];
    for (const source of probes) {
      const result = await invoke("code.run", { source }, ctx());
      // Either it evaluates to "undefined", or requiring the module fails.
      if (result.ok) expect(result.output, source).toMatch(/undefined/);
      else expect(result.error, source).toMatch(/Cannot find module/);
    }
  });

  it("bounds what agent code can write into the workspace", async () => {
    const c = ctx();
    const result = await invoke(
      "file.write",
      { path: "/huge.txt", content: "x".repeat(500_000) },
      c,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limit/);
  });

  it("cannot exhaust memory through runaway console output", async () => {
    const result = await invoke(
      "code.run",
      { source: `for (let i = 0; i < 5e5; i++) console.log("x".repeat(200));` },
      ctx(),
    );
    expect(result.output.length).toBeLessThan(60_000);
  });

  it("terminates a runaway loop rather than hanging the process", async () => {
    const started = Date.now();
    const result = await invoke("code.run", { source: `while (true) {}` }, ctx());
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("artifact rendering", () => {
  it("renders agent HTML in a sandboxed frame with scripts withheld", () => {
    const viewer = readFileSync("src/components/arena/ArtifactViewer.tsx", "utf8");
    expect(viewer).toMatch(/<iframe/);
    expect(viewer).not.toMatch(/dangerouslySetInnerHTML/);

    // Check the attribute values themselves, not the prose around them.
    const sandboxAttrs = [...viewer.matchAll(/sandbox=(?:"([^"]*)"|\{([^}]*)\})/g)].map(
      (m) => m[1] ?? m[2] ?? "",
    );
    expect(sandboxAttrs.length).toBeGreaterThan(0);
    for (const value of sandboxAttrs) {
      expect(value.trim()).toBe("");
    }
  });

  it("never injects agent output as raw HTML anywhere in the UI", () => {
    // There is exactly one permitted use: the JSON-LD block on the landing page,
    // which is the standard way to emit structured data. It is allowed only
    // because its content is a literal defined in the same file and serialised
    // with JSON.stringify — no agent output, no user input, no request data can
    // reach it. Any other use is a real finding.
    const ALLOWED = new Set(["src/app/page.tsx"]);

    const offenders = SOURCES.filter(
      (file) =>
        /dangerouslySetInnerHTML/.test(readFileSync(file, "utf8")) &&
        !ALLOWED.has(file.replace(/\\/g, "/")),
    );
    expect(offenders).toEqual([]);

    for (const file of ALLOWED) {
      const text = readFileSync(file, "utf8");
      const uses = [...text.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+)\}\}/g)].map(
        (m) => m[1]!.trim(),
      );
      expect(uses, `${file} should still contain the JSON-LD block`).toHaveLength(1);
      // The payload must be a JSON.stringify of the local literal, nothing else.
      expect(uses[0]).toBe("JSON.stringify(structuredData)");
      expect(text).toMatch(/const structuredData = \{/);
    }
  });
});
