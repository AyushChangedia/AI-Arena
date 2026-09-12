import { describe, expect, it, beforeEach } from "vitest";
import { Vfs } from "@/lib/sandbox/vfs";
import { NodeVmExecutor } from "@/lib/sandbox/vm";
import { VirtualShell, tokenise } from "@/lib/sandbox/shell";

function makeShell(seed: Record<string, string> = {}) {
  const vfs = Vfs.fromSnapshot(seed);
  const shell = new VirtualShell({ vfs, executor: new NodeVmExecutor(), timeoutMs: 3000 });
  return { vfs, shell };
}

describe("tokenise", () => {
  it("respects quotes and escapes", () => {
    expect(tokenise(`echo "hello world" 'a b' c\\ d`)).toEqual(["echo", "hello world", "a b", "c d"]);
  });
  it("keeps empty quoted strings", () => {
    expect(tokenise(`echo ""`)).toEqual(["echo", ""]);
  });
});

describe("VirtualShell", () => {
  let shell: VirtualShell;
  let vfs: Vfs;

  beforeEach(() => {
    ({ shell, vfs } = makeShell({
      "/README.md": "# Project\nrun the tests\n",
      "/src/index.js": `module.exports = 1;\n`,
      "/src/util.js": `exports.double = (n) => n * 2;\n`,
    }));
  });

  it("lists directories and files", async () => {
    const r = await shell.exec("ls");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")).toEqual(["src/", "README.md"]);
  });

  it("cats a file", async () => {
    expect((await shell.exec("cat README.md")).stdout).toContain("# Project");
  });

  it("returns a real error for a missing file", async () => {
    const r = await shell.exec("cat nope.txt");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it("refuses unknown commands with exit 127 rather than falling through", async () => {
    const r = await shell.exec("curl https://example.com");
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/command not found/);
  });

  it("has no path to host binaries", async () => {
    for (const cmd of ["bash", "sh", "python", "rm -rf /etc", "sudo ls", "eval"]) {
      const r = await shell.exec(cmd);
      expect([1, 127]).toContain(r.exitCode);
    }
  });

  it("blocks traversal outside the workspace", async () => {
    const r = await shell.exec("cat ../../../etc/passwd");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/escapes the workspace root/);
  });

  it("writes via redirect", async () => {
    await shell.exec(`echo "hello" > out.txt`);
    expect(vfs.read("/out.txt")).toBe("hello\n");
    await shell.exec(`echo "world" >> out.txt`);
    expect(vfs.read("/out.txt")).toBe("hello\nworld\n");
  });

  it("pipes between commands", async () => {
    const r = await shell.exec(`cat README.md | grep tests`);
    expect(r.stdout).toBe("run the tests");
  });

  it("sequences with && and short-circuits on failure", async () => {
    const ok = await shell.exec(`echo one && echo two`);
    expect(ok.stdout).toBe("one\ntwo");
    const bad = await shell.exec(`cat missing.txt && echo unreachable`);
    expect(bad.stdout).not.toContain("unreachable");
  });

  it("greps recursively through a directory", async () => {
    const r = await shell.exec(`grep -n double src`);
    expect(r.stdout).toContain("/src/util.js:1:");
  });

  it("counts lines", async () => {
    expect((await shell.exec("wc -l README.md")).stdout).toBe("3");
  });

  it("creates and removes directories", async () => {
    await shell.exec("mkdir -p build/assets");
    expect(vfs.isDir("/build/assets")).toBe(true);
    await shell.exec("touch build/assets/a.txt");
    const r = await shell.exec("rm -r build");
    expect(r.exitCode).toBe(0);
    expect(vfs.exists("/build")).toBe(false);
  });

  it("changes directory and resolves relative paths against it", async () => {
    await shell.exec("cd src");
    expect((await shell.exec("pwd")).stdout).toBe("/src");
    expect((await shell.exec("cat util.js")).stdout).toContain("double");
  });

  it("runs node against the VM executor", async () => {
    vfs.write("/run.js", `console.log("from node", require("./src/util").double(21));`);
    const r = await shell.exec("node run.js");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("from node 42");
  });

  it("surfaces node runtime failures with a non-zero exit", async () => {
    vfs.write("/boom.js", `throw new Error("kaboom");`);
    const r = await shell.exec("node boom.js");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/kaboom/);
  });

  it("reports npm as unavailable unless the task registers it", async () => {
    const r = await shell.exec("npm test");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/no package registry|registers no npm scripts/);
  });

  it("routes npm to a task-registered hook", async () => {
    const hooked = new VirtualShell({
      vfs,
      executor: new NodeVmExecutor(),
      hooks: {
        npm: (argv) => ({
          stdout: argv[1] === "test" ? "3 passing" : "unknown script",
          stderr: "",
          exitCode: argv[1] === "test" ? 0 : 1,
          durationMs: 1,
        }),
      },
    });
    const r = await hooked.exec("npm test");
    expect(r.stdout).toBe("3 passing");
    expect(r.exitCode).toBe(0);
  });

  it("truncates enormous output", async () => {
    const small = new VirtualShell({
      vfs,
      executor: new NodeVmExecutor(),
      maxOutputChars: 100,
    });
    vfs.write("/big.txt", "x".repeat(5000));
    const r = await small.exec("cat big.txt");
    expect(r.stdout.length).toBeLessThan(200);
    expect(r.stdout).toMatch(/truncated/);
  });

  it("handles an empty command line", async () => {
    const r = await shell.exec("   ");
    expect(r.exitCode).toBe(0);
  });

  it("lists available commands via help", async () => {
    const r = await shell.exec("help");
    expect(r.stdout).toMatch(/available commands/);
    expect(r.stdout).toMatch(/grep/);
  });
});
