"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExecutionEvent, ExecutionEventType, Side } from "@/lib/arena/types";
import { cx } from "@/components/ui/primitives";

/**
 * The event stream.
 *
 * Windowed above a threshold: a long trace renders a slice sized to the
 * viewport rather than four thousand DOM nodes. Auto-follow disengages the
 * moment the reader scrolls up, and re-engages when they return to the bottom —
 * so reading history is never fought by the live tail.
 */

const ROW_HEIGHT = 26;
const OVERSCAN = 12;

const TYPE_STYLE: Partial<Record<ExecutionEventType, { glyph: string; tone: string }>> = {
  "agent.started": { glyph: "▸", tone: "text-mid" },
  "agent.planning": { glyph: "◇", tone: "text-dim" },
  "agent.thinking": { glyph: "◇", tone: "text-dim" },
  "agent.message": { glyph: "„", tone: "text-mid" },
  "agent.tool_called": { glyph: "→", tone: "text-mid" },
  "agent.tool_completed": { glyph: "✓", tone: "text-ok" },
  "agent.tool_failed": { glyph: "✕", tone: "text-fail" },
  "agent.command_executed": { glyph: "$", tone: "text-mid" },
  "agent.command_failed": { glyph: "$", tone: "text-fail" },
  "agent.file_created": { glyph: "+", tone: "text-ok" },
  "agent.file_modified": { glyph: "~", tone: "text-mid" },
  "agent.recovery_started": { glyph: "↻", tone: "text-warn" },
  "agent.recovery_completed": { glyph: "↻", tone: "text-ok" },
  "agent.artifact_created": { glyph: "▣", tone: "text-a" },
  "agent.limit_reached": { glyph: "!", tone: "text-fail" },
  "agent.task_completed": { glyph: "■", tone: "text-ok" },
  "agent.task_failed": { glyph: "■", tone: "text-fail" },
  "agent.state_changed": { glyph: "·", tone: "text-dim" },
  "eval.started": { glyph: "⚖", tone: "text-mid" },
  "eval.dimension": { glyph: "⚖", tone: "text-mid" },
  "eval.completed": { glyph: "⚖", tone: "text-mid" },
  "match.started": { glyph: "▶", tone: "text-a" },
  "match.completed": { glyph: "◼", tone: "text-a" },
};

export function EventStream({
  events,
  height = 260,
  filter,
  onFilterChange,
}: {
  events: ExecutionEvent[];
  height?: number;
  filter?: Side | "all";
  onFilterChange?: (filter: Side | "all") => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);

  const shown = filter && filter !== "all" ? events.filter((e) => e.side === filter || e.side === null) : events;

  // Follow the tail unless the reader has scrolled away from it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [shown.length, follow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 1.5;
      setFollow(atBottom);
      setScrollTop(el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const total = shown.length;
  const windowed = total > 120;
  const first = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const visibleCount = windowed ? Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2 : total;
  const slice = shown.slice(first, first + visibleCount);

  return (
    <div className="flex min-h-0 flex-col border border-line bg-base">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <span className="mono-label text-dim">Event stream</span>
        <span className="tnum mono-label text-dim">{total}</span>
        <span className="ml-auto flex items-center gap-1">
          {onFilterChange
            ? (["all", "A", "B"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onFilterChange(option)}
                  aria-pressed={filter === option}
                  className={cx(
                    "mono-label border px-2 py-1 transition-colors",
                    filter === option
                      ? "border-line-strong bg-surface text-text"
                      : "border-transparent text-dim hover:text-mid",
                  )}
                >
                  {option === "all" ? "Both" : option}
                </button>
              ))
            : null}
          {!follow ? (
            <button
              type="button"
              onClick={() => {
                setFollow(true);
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              className="mono-label border border-a-line bg-a-deep px-2 py-1 text-a"
            >
              Follow
            </button>
          ) : null}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 overflow-y-auto font-mono text-[11px]" style={{ height }}>
        {total === 0 ? (
          <p className="px-4 py-6 text-dim">No events yet.</p>
        ) : (
          <div style={{ height: windowed ? total * ROW_HEIGHT : undefined, position: "relative" }}>
            <div
              style={
                windowed
                  ? { position: "absolute", top: first * ROW_HEIGHT, left: 0, right: 0 }
                  : undefined
              }
            >
              {slice.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: ExecutionEvent }) {
  const style = TYPE_STYLE[event.type] ?? { glyph: "·", tone: "text-dim" };
  const sideTone = event.side === "A" ? "text-a" : event.side === "B" ? "text-b" : "text-dim";

  return (
    <div
      className="flex items-center gap-2.5 border-b border-line/50 px-4 hover:bg-surface"
      style={{ height: ROW_HEIGHT }}
      title={event.detail}
    >
      <span className="tnum w-14 shrink-0 text-dim">{formatT(event.t)}</span>
      <span className={cx("w-4 shrink-0 text-center", sideTone)}>{event.side ?? "·"}</span>
      <span className={cx("w-3 shrink-0 text-center", style.tone)} aria-hidden>
        {style.glyph}
      </span>
      <span className="min-w-0 flex-1 truncate text-mid">{event.label}</span>
      {event.durationMs !== undefined ? (
        <span className="tnum shrink-0 text-dim">{event.durationMs}ms</span>
      ) : null}
    </div>
  );
}

/**
 * Adaptive precision. A demo match completes in single-digit milliseconds, and
 * rendering that as "00.00s" for every row throws away the only ordering
 * information the column carries.
 */
function formatT(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${seconds}.${String(centis).padStart(2, "0")}s`;
}
