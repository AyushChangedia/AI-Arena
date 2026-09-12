"use client";

import { useState } from "react";
import type { Artifact } from "@/lib/arena/types";
import { Chip, cx } from "@/components/ui/primitives";

/**
 * Artifact viewer.
 *
 * HTML artifacts render in a sandboxed iframe with `allow-scripts` withheld and
 * a null origin — it is the agent's output, which is untrusted by definition.
 * Everything else is shown as source. What you see is the exact bytes the
 * grader read.
 */

export function ArtifactViewer({
  artifacts,
  accent = "amber",
  height = 420,
}: {
  artifacts: Artifact[];
  accent?: "amber" | "cyan";
  height?: number;
}) {
  const [activePath, setActivePath] = useState(artifacts.find((a) => a.primary)?.path ?? artifacts[0]?.path ?? "");
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const active = artifacts.find((a) => a.path === activePath) ?? artifacts[0];

  if (artifacts.length === 0) {
    return (
      <div className="hatch grid border border-line" style={{ height }}>
        <p className="mono-label m-auto bg-void px-3 py-2 text-dim">No artifacts produced</p>
      </div>
    );
  }

  const canPreview = active?.kind === "html";

  return (
    <div className="flex min-h-0 flex-col border border-line bg-base">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {artifacts.map((artifact) => (
            <button
              key={artifact.path}
              type="button"
              onClick={() => setActivePath(artifact.path)}
              className={cx(
                "mono-label max-w-[22ch] truncate border px-2 py-1 transition-colors",
                artifact.path === activePath
                  ? accent === "amber"
                    ? "border-a-line bg-a-deep text-a"
                    : "border-b-line bg-b-deep text-b"
                  : "border-transparent text-dim hover:text-mid",
              )}
              title={artifact.path}
            >
              {artifact.primary ? "★ " : ""}
              {artifact.path.split("/").pop()}
            </button>
          ))}
        </div>

        {canPreview ? (
          <div className="flex shrink-0 gap-1">
            {(["preview", "source"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={cx(
                  "mono-label border px-2 py-1 transition-colors",
                  mode === option ? "border-line-strong bg-surface text-text" : "border-transparent text-dim hover:text-mid",
                )}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {active ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
            <span className="truncate font-mono text-[11px] text-dim">{active.path}</span>
            <Chip tone="muted" className="ml-auto">
              {active.kind}
            </Chip>
            <span className="tnum font-mono text-[11px] text-dim">{formatBytes(active.bytes)}</span>
          </div>

          {canPreview && mode === "preview" ? (
            <iframe
              // No allow-scripts: agent output is untrusted, and the grader read
              // the markup, not the result of running it.
              sandbox=""
              srcDoc={active.content}
              title={`Preview of ${active.path}`}
              className="w-full flex-1 border-0 bg-white"
              style={{ height }}
            />
          ) : (
            <pre
              className="overflow-auto p-4 font-mono text-[11px] leading-relaxed text-mid"
              style={{ height }}
            >
              <code>{active.content}</code>
            </pre>
          )}
        </>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
