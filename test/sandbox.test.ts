import { describe, expect, it } from "vitest";
import { Vfs, VfsError, normalisePath, fnv1a64 } from "@/lib/sandbox/vfs";
import { NodeVmExecutor, SandboxDisabledExecutor, createCodeExecutor } from "@/lib/sandbox/vm";

describe("normalisePath", () => {
  it("resolves relative segments against the cwd", () => {
    expect(normalisePath("b.txt", "/a")).toBe("/a/b.txt");
    expect(normalisePath("./b.txt", "/a")).toBe("/a/b.txt");
    expect(normalisePath("/a//b/../c.txt")).toBe("/a/c.txt");
  });

  it("rejects traversal above the root", () => {
    expect(() => normalisePath("../../etc/passwd")).toThrow(VfsError);
    expect(() => normalisePath("/a/../../x")).toThrow(/escapes the workspace root/);
  });

  it("rejects null bytes and overlong paths", () => {
    expect(() => normalisePath(`a${String.fromCharCode(0)}b`)).toThrow(/null byte/);
    expect(() => normalisePath("a".repeat(500))).toThrow(/exceeds/);
  });
});

describe("Vfs", () => {
  it("creates parent directories on write and lists them", () => {
    const vfs = new Vfs();
    vfs.write("build/css/main.css", "body{}");
    expect(vfs.isDir("/build")).toBe(true);
    expect(vfs.list("/build").map((e) => e.name)).toEqual(["css"]);
    expect(vfs.read("/build/css/main.css")).toBe("body{}");
  });

  it("throws ENOENT for a missing file rather than returning empty", () => {
    const vfs = new Vfs();
    expect(() => vfs.read("/nope.txt")).toThrow(VfsError);
    try {
      vfs.read("/nope.txt");
    } catch (e) {
      expect((e as VfsError).code).toBe("ENOENT");
    }
  });

  it("enforces the single-file byte ceiling", () => {
    const vfs = new Vfs({ maxTotalBytes: 10_000, maxFiles: 10, maxFileBytes: 50, maxPathLength: 100 });
    expect(() => vfs.write("/big.txt", "x".repeat(51))).toThrow(/single-file limit/);
  });

  it("enforces the total byte and file-count ceilings", () => {
    const vfs = new Vfs({ maxTotalBytes: 30, maxFiles: 2, maxFileBytes: 100, maxPathLength: 100 });
    vfs.write("/a.txt", "x".repeat(20));
    expect(() => vfs.write("/b.txt", "x".repeat(20))).toThrow(/total limit/);
    vfs.write("/b.txt", "y");
    expect(() => vfs.write("/c.txt", "z")).toThrow(/file limit/);
  });

  it("tracks created vs modified and drains the change log once", () => {
    const vfs = new Vfs();
    vfs.write("/a.txt", "1");
    vfs.write("/a.txt", "2");
    const changes = vfs.drainChanges();
    expect(changes.map((c) => c.kind)).toEqual(["created", "modified"]);
    expect(vfs.drainChanges()).toEqual([]);
  });

  it("removes directories only when recursive", () => {
    const vfs = new Vfs();
    vfs.write("/d/a.txt", "a");
    vfs.write("/d/b.txt", "b");
    expect(() => vfs.remove("/d")).toThrow(/directory/);
    expect(vfs.remove("/d", "/", true)).toBe(2);
    expect(vfs.exists("/d/a.txt")).toBe(false);
  });

  it("refuses to remove the root", () => {
    expect(() => new Vfs().remove("/")).toThrow(/workspace root/);
  });

  it("hashes content, not insertion order", () => {
    const a = new Vfs();
    a.write("/one.txt", "1");
    a.write("/two.txt", "2");
    const b = new Vfs();
    b.write("/two.txt", "2");
    b.write("/one.txt", "1");
    expect(a.hash()).toBe(b.hash());

    b.write("/one.txt", "changed");
    expect(a.hash()).not.toBe(b.hash());
  });

  it("round-trips through a snapshot", () => {
    const a = new Vfs();
    a.write("/src/index.js", "module.exports = 1;");
    const b = Vfs.fromSnapshot(a.toSnapshot());
    expect(b.hash()).toBe(a.hash());
    expect(b.drainChanges()).toEqual([]);
  });
});

describe("fnv1a64", () => {
  it("is deterministic and collision-resistant for near-identical inputs", () => {
    expect(fnv1a64("abc")).toBe(fnv1a64("abc"));
    expect(fnv1a64("abc")).not.toBe(fnv1a64("abd"));
    expect(fnv1a64("")).toHaveLength(16);
  });
});

describe("NodeVmExecutor", () => {
  const exec = new NodeVmExecutor();

  it("runs a module and captures stdout", () => {
    const vfs = new Vfs();
    vfs.write("/main.js", `console.log("hello", 41 + 1); module.exports = { ok: true };`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("hello 42");
    expect(r.value).toEqual({ ok: true });
  });

  it("resolves relative requires across the workspace", () => {
    const vfs = new Vfs();
    vfs.write("/lib/add.js", `module.exports = (a, b) => a + b;`);
    vfs.write("/main.js", `const add = require("./lib/add"); module.exports = add(2, 3);`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(5);
  });

  it("loads JSON modules", () => {
    const vfs = new Vfs();
    vfs.write("/data.json", `{"n": 7}`);
    vfs.write("/main.js", `module.exports = require("./data.json").n;`);
    expect(exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 }).value).toBe(7);
  });

  it("terminates infinite loops at the timeout", () => {
    const vfs = new Vfs();
    vfs.write("/spin.js", `while (true) {}`);
    const r = exec.run(vfs, { entry: "/spin.js", timeoutMs: 150 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error?.name).toBe("TimeoutError");
    expect(r.durationMs).toBeLessThan(3000);
  });

  it("terminates loops nested inside dynamically constructed functions", () => {
    const vfs = new Vfs();
    vfs.write("/evil.js", `const f = Function("while(true){}"); f();`);
    const r = exec.run(vfs, { entry: "/evil.js", timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
  });

  it("exposes no host bindings", () => {
    const vfs = new Vfs();
    vfs.write(
      "/probe.js",
      `module.exports = {
         process: typeof process,
         fetch: typeof fetch,
         setTimeout: typeof setTimeout,
         Buffer: typeof Buffer,
         globalRequire: typeof globalThis.require,
       };`,
    );
    const r = exec.run(vfs, { entry: "/probe.js", timeoutMs: 2000 });
    expect(r.value).toEqual({
      process: "undefined",
      fetch: "undefined",
      setTimeout: "undefined",
      Buffer: "undefined",
      globalRequire: "undefined",
    });
  });

  it("cannot require anything outside the workspace", () => {
    const vfs = new Vfs();
    vfs.write("/main.js", `module.exports = require("node:fs");`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Cannot find module/);
  });

  it("cannot escape the workspace root via relative requires", () => {
    const vfs = new Vfs();
    vfs.write("/main.js", `module.exports = require("../../etc/passwd");`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/escapes the workspace root|Cannot find module/);
  });

  it("reports syntax errors against the offending module", () => {
    const vfs = new Vfs();
    vfs.write("/broken.js", `function ( {`);
    const r = exec.run(vfs, { entry: "/broken.js", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Syntax error in \/broken\.js/);
  });

  it("surfaces runtime errors without crashing the host", () => {
    const vfs = new Vfs();
    vfs.write("/throws.js", `throw new RangeError("nope");`);
    const r = exec.run(vfs, { entry: "/throws.js", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("RangeError");
    expect(r.error?.message).toBe("nope");
  });

  it("evaluates expressions against workspace modules (the grader path)", () => {
    const vfs = new Vfs();
    vfs.write("/auth.js", `exports.verify = (t) => t === "good";`);
    const ok = exec.evaluate(vfs, { expression: `require("/auth.js").verify("good")`, timeoutMs: 2000 });
    expect(ok.value).toBe(true);
    const bad = exec.evaluate(vfs, { expression: `require("/auth.js").verify("bad")`, timeoutMs: 2000 });
    expect(bad.value).toBe(false);
  });

  it("passes input through to the module", () => {
    const vfs = new Vfs();
    vfs.write("/main.js", `module.exports = ARENA_INPUT.a * 2;`);
    expect(exec.run(vfs, { entry: "/main.js", timeoutMs: 2000, input: { a: 21 } }).value).toBe(42);
  });

  it("truncates runaway output instead of exhausting memory", () => {
    const vfs = new Vfs();
    vfs.write("/loud.js", `for (let i = 0; i < 100000; i++) console.log("line " + i);`);
    const r = exec.run(vfs, { entry: "/loud.js", timeoutMs: 5000, maxOutputChars: 500 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThan(2000);
  });

  it("returns ENOENT for a missing entry", () => {
    const r = exec.run(new Vfs(), { entry: "/missing.js", timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Cannot find module/);
  });

  it("isolates contexts between runs", () => {
    const vfs = new Vfs();
    vfs.write("/leak.js", `globalThis.LEAKED = 1; module.exports = 1;`);
    exec.run(vfs, { entry: "/leak.js", timeoutMs: 1000 });
    vfs.write("/check.js", `module.exports = typeof globalThis.LEAKED;`);
    expect(exec.run(vfs, { entry: "/check.js", timeoutMs: 1000 }).value).toBe("undefined");
  });
});

describe("SandboxDisabledExecutor", () => {
  it("refuses cleanly with a reason instead of pretending to run", () => {
    const r = new SandboxDisabledExecutor().run();
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("SandboxDisabled");
    expect(r.stderr).toMatch(/disabled/);
  });

  it("is selected when the env flag is off", () => {
    expect(createCodeExecutor({ ARENA_ENABLE_VM_SANDBOX: "0" }).available).toBe(false);
    expect(createCodeExecutor({}).available).toBe(true);
  });
});

describe("workspace access from inside the sandbox", () => {
  const exec = new NodeVmExecutor();

  it("reads non-JS workspace files with readFile", () => {
    const vfs = new Vfs();
    vfs.write("/data/orders.csv", "a,b\n1,2\n");
    vfs.write("/main.js", `module.exports = readFile("/data/orders.csv").trim().split("\\n").length;`);
    expect(exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 }).value).toBe(2);
  });

  it("throws ENOENT from readFile for a missing path", () => {
    const vfs = new Vfs();
    vfs.write("/main.js", `module.exports = readFile("/nope.csv");`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/ENOENT/);
  });

  it("cannot read outside the workspace root", () => {
    const vfs = new Vfs();
    vfs.write("/main.js", `module.exports = readFile("../../etc/passwd");`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/escapes the workspace root/);
  });

  it("lists the workspace and reports existence", () => {
    const vfs = new Vfs();
    vfs.write("/a.txt", "x");
    vfs.write("/main.js", `module.exports = { files: listFiles(), has: fileExists("/a.txt"), no: fileExists("/b.txt") };`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.value).toEqual({ files: ["/a.txt", "/main.js"], has: true, no: false });
  });

  it("exposes no way to write to the workspace", () => {
    const vfs = new Vfs();
    vfs.write("/main.js", `module.exports = [typeof writeFile, typeof globalThis.writeFile];`);
    expect(exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 }).value).toEqual(["undefined", "undefined"]);
  });

  it("does not execute non-JS files as modules", () => {
    const vfs = new Vfs();
    vfs.write("/page.html", "<h1>hi</h1>");
    vfs.write("/main.js", `module.exports = require("./page.html");`);
    const r = exec.run(vfs, { entry: "/main.js", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Cannot find module/);
  });
});
