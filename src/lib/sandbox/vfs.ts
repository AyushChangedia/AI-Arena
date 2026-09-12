/**
 * Virtual filesystem.
 *
 * A real filesystem implementation that lives entirely in memory: path
 * normalisation, traversal rejection, byte and file-count ceilings, real
 * ENOENT-style errors. It never touches the host disk, by construction — there
 * is no `node:fs` import in this file or anything it calls.
 *
 * Two executions in the same match hold two independent instances built from
 * the same spec; `hash()` is what the engine asserts equal before step 1.
 */

export interface VfsLimits {
  maxTotalBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxPathLength: number;
}

export const DEFAULT_VFS_LIMITS: VfsLimits = {
  maxTotalBytes: 2_000_000,
  maxFiles: 200,
  maxFileBytes: 400_000,
  maxPathLength: 180,
};

export class VfsError extends Error {
  constructor(
    readonly code: "ENOENT" | "EISDIR" | "ENOTDIR" | "EINVAL" | "EEXIST" | "ELIMIT" | "EACCES",
    message: string,
  ) {
    super(message);
    this.name = "VfsError";
  }
}

export interface VfsFile {
  path: string;
  content: string;
  bytes: number;
  createdAt: number;
  modifiedAt: number;
  revisions: number;
}

export interface VfsChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  bytes: number;
}

const NUL = String.fromCharCode(0);
const SEP_FIELD = String.fromCharCode(1);

/**
 * Normalise a path against a cwd. Rejects anything that escapes the root, any
 * NUL byte, and anything over the length ceiling. Always returns an absolute
 * path with no trailing slash (except the root itself).
 */
export function normalisePath(
  input: string,
  cwd = "/",
  maxLength = DEFAULT_VFS_LIMITS.maxPathLength,
): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new VfsError("EINVAL", "path must be a non-empty string");
  }
  if (input.includes(NUL)) {
    throw new VfsError("EINVAL", "path contains a null byte");
  }
  if (input.length > maxLength) {
    throw new VfsError("EINVAL", `path exceeds ${maxLength} characters`);
  }

  const raw = input.startsWith("/") ? input : `${cwd}/${input}`;
  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) {
        // Escaping the root is a hard error, not a silent clamp.
        throw new VfsError("EACCES", `path escapes the workspace root: ${input}`);
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

export class Vfs {
  private files = new Map<string, VfsFile>();
  private dirs = new Set<string>(["/"]);
  private changeLog: VfsChange[] = [];
  private cursor = 0;

  constructor(
    readonly limits: VfsLimits = DEFAULT_VFS_LIMITS,
    private now: () => number = () => Date.now(),
  ) {}

  // ── queries ───────────────────────────────────────────────────────────────

  get totalBytes(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.bytes;
    return n;
  }

  get fileCount(): number {
    return this.files.size;
  }

  exists(path: string, cwd = "/"): boolean {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    return this.files.has(p) || this.dirs.has(p);
  }

  isDir(path: string, cwd = "/"): boolean {
    return this.dirs.has(normalisePath(path, cwd, this.limits.maxPathLength));
  }

  isFile(path: string, cwd = "/"): boolean {
    return this.files.has(normalisePath(path, cwd, this.limits.maxPathLength));
  }

  read(path: string, cwd = "/"): string {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    const f = this.files.get(p);
    if (!f) {
      if (this.dirs.has(p)) throw new VfsError("EISDIR", `${p} is a directory`);
      throw new VfsError("ENOENT", `no such file: ${p}`);
    }
    return f.content;
  }

  stat(path: string, cwd = "/"): VfsFile {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    const f = this.files.get(p);
    if (!f) throw new VfsError("ENOENT", `no such file: ${p}`);
    return { ...f };
  }

  /** Direct children of a directory, directories first, then files. */
  list(
    path = "/",
    cwd = "/",
  ): { name: string; path: string; type: "file" | "dir"; bytes: number }[] {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    if (!this.dirs.has(p)) {
      if (this.files.has(p)) throw new VfsError("ENOTDIR", `${p} is a file`);
      throw new VfsError("ENOENT", `no such directory: ${p}`);
    }
    const prefix = p === "/" ? "/" : `${p}/`;
    const seen = new Map<string, { name: string; path: string; type: "file" | "dir"; bytes: number }>();

    for (const d of this.dirs) {
      if (d === p || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.includes("/")) continue;
      seen.set(rest, { name: rest, path: d, type: "dir", bytes: 0 });
    }
    for (const f of this.files.values()) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      if (rest.includes("/")) continue;
      seen.set(rest, { name: rest, path: f.path, type: "file", bytes: f.bytes });
    }
    return [...seen.values()].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
  }

  /** Every file in the tree, sorted by path. */
  entries(): VfsFile[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  walk(path = "/", cwd = "/"): string[] {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    const prefix = p === "/" ? "/" : `${p}/`;
    return this.entries()
      .filter((f) => f.path === p || f.path.startsWith(prefix))
      .map((f) => f.path);
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  mkdirp(path: string, cwd = "/"): void {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    if (this.files.has(p)) throw new VfsError("EEXIST", `${p} exists and is a file`);
    const parts = p.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      if (this.files.has(acc)) throw new VfsError("ENOTDIR", `${acc} is a file`);
      this.dirs.add(acc);
    }
  }

  write(path: string, content: string, cwd = "/"): VfsChange {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    if (this.dirs.has(p)) throw new VfsError("EISDIR", `${p} is a directory`);
    if (typeof content !== "string") throw new VfsError("EINVAL", "content must be a string");

    const bytes = byteLength(content);
    if (bytes > this.limits.maxFileBytes) {
      throw new VfsError(
        "ELIMIT",
        `file exceeds the ${fmtBytes(this.limits.maxFileBytes)} single-file limit (${fmtBytes(bytes)})`,
      );
    }

    const existing = this.files.get(p);
    const projected = this.totalBytes - (existing?.bytes ?? 0) + bytes;
    if (projected > this.limits.maxTotalBytes) {
      throw new VfsError(
        "ELIMIT",
        `workspace exceeds the ${fmtBytes(this.limits.maxTotalBytes)} total limit`,
      );
    }
    if (!existing && this.files.size + 1 > this.limits.maxFiles) {
      throw new VfsError("ELIMIT", `workspace exceeds the ${this.limits.maxFiles} file limit`);
    }

    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    this.mkdirp(parent);

    const t = this.now();
    if (existing) {
      existing.content = content;
      existing.bytes = bytes;
      existing.modifiedAt = t;
      existing.revisions += 1;
    } else {
      this.files.set(p, {
        path: p,
        content,
        bytes,
        createdAt: t,
        modifiedAt: t,
        revisions: 1,
      });
    }
    const change: VfsChange = { path: p, kind: existing ? "modified" : "created", bytes };
    this.changeLog.push(change);
    return change;
  }

  append(path: string, content: string, cwd = "/"): VfsChange {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    const prev = this.files.get(p)?.content ?? "";
    return this.write(p, prev + content);
  }

  remove(path: string, cwd = "/", recursive = false): number {
    const p = normalisePath(path, cwd, this.limits.maxPathLength);
    if (p === "/") throw new VfsError("EACCES", "refusing to remove the workspace root");

    const file = this.files.get(p);
    if (file) {
      this.files.delete(p);
      this.changeLog.push({ path: p, kind: "deleted", bytes: file.bytes });
      return 1;
    }
    if (this.dirs.has(p)) {
      if (!recursive) throw new VfsError("EISDIR", `${p} is a directory (use recursive)`);
      const prefix = `${p}/`;
      let n = 0;
      for (const f of [...this.files.values()]) {
        if (f.path.startsWith(prefix)) {
          this.files.delete(f.path);
          this.changeLog.push({ path: f.path, kind: "deleted", bytes: f.bytes });
          n++;
        }
      }
      for (const d of [...this.dirs]) if (d === p || d.startsWith(prefix)) this.dirs.delete(d);
      return n;
    }
    throw new VfsError("ENOENT", `no such file or directory: ${p}`);
  }

  copy(from: string, to: string, cwd = "/"): VfsChange {
    return this.write(to, this.read(from, cwd), cwd);
  }

  move(from: string, to: string, cwd = "/"): VfsChange {
    const change = this.copy(from, to, cwd);
    this.remove(from, cwd);
    return change;
  }

  // ── change tracking (drives file.created / file.modified events) ──────────

  /** Changes since the last call. The harness drains this after every tool call. */
  drainChanges(): VfsChange[] {
    const out = this.changeLog.slice(this.cursor);
    this.cursor = this.changeLog.length;
    return out;
  }

  // ── fairness & persistence ────────────────────────────────────────────────

  /**
   * Order-independent content hash of the whole tree. The engine asserts that
   * both sides of a match hash identically before either takes a step.
   */
  hash(): string {
    const parts = this.entries().map((f) => `${f.path}${NUL}${f.content}`);
    return fnv1a64(parts.join(SEP_FIELD));
  }

  toSnapshot(): Record<string, string> {
    return Object.fromEntries(this.entries().map((f) => [f.path, f.content]));
  }

  static fromSnapshot(
    snapshot: Record<string, string>,
    limits = DEFAULT_VFS_LIMITS,
    now?: () => number,
  ): Vfs {
    const vfs = new Vfs(limits, now);
    for (const [path, content] of Object.entries(snapshot)) vfs.write(path, content);
    vfs.drainChanges();
    return vfs;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function byteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * FNV-1a over 32-bit halves, rendered as 16 hex chars. Deterministic across
 * processes and platforms — the fairness check depends on that.
 */
export function fnv1a64(input: string): string {
  let h1 = 0x811c_9dc5;
  let h2 = 0x0100_0193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x0100_0193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x0100_01b3) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
