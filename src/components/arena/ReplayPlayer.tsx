"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, RotateCcw } from "lucide-react";
import type { ExecutionEvent, Replay, Side } from "@/lib/arena/types";
import { EventStream } from "./EventStream";
import { Chip, cx, fmtMs } from "@/components/ui/primitives";

/**
 * Replay.
 *
 * The scrub axis is the event index, not wall-clock time. That is deliberate:
 * a demo match completes in tens of milliseconds, so a time axis would compress
 * the entire run into one pixel. Each position still reports the real timestamp
 * it happened at, and the markers are the moments worth jumping to — failures,
 * recoveries, artifacts, the finish.
 */

const SPEEDS = [0.5, 1, 2, 4] as const;
type ReplaySpeed = (typeof SPEEDS)[number];

const MARKER_TONE: Record<string, string> = {
  "agent.tool_failed": "bg-fail",
  "agent.recovery_completed": "bg-ok",
  "agent.artifact_created": "bg-a",
  "agent.task_completed": "bg-ok",
  "agent.task_failed": "bg-fail",
  "agent.limit_reached": "bg-fail",
  "match.completed": "bg-mid",
};

export function ReplayPlayer({ replay }: { replay: Replay }) {
  const total = replay.events.length;
  const [cursor, setCursor] = useState(total);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [filter, setFilter] = useState<Side | "all">("all");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Playback stops at the end by simply having nothing left to schedule, rather
  // than by writing state back during the effect body.
  const atEnd = cursor >= total;

  useEffect(() => {
    if (!playing || atEnd) return;
    timer.current = setTimeout(() => {
      setCursor((c) => {
        const next = Math.min(total, c + 1);
        if (next >= total) setPlaying(false);
        return next;
      });
    }, 260 / speed);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [playing, atEnd, cursor, total, speed]);

  const visible = useMemo(() => replay.events.slice(0, cursor), [replay.events, cursor]);
  const current: ExecutionEvent | undefined = replay.events[Math.max(0, cursor - 1)];

  const markerPositions = useMemo(
    () =>
      replay.markers.map((marker) => {
        const index = replay.events.findIndex((e) => e.t === marker.t && e.label === marker.label);
        return { ...marker, index: index < 0 ? 0 : index };
      }),
    [replay],
  );

  function restart() {
    setCursor(0);
    setPlaying(true);
  }

  return (
    <div className="border border-line bg-base">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-1">
          <ControlButton
            label={playing ? "Pause" : "Play"}
            onClick={() => {
              if (atEnd) restart();
              else setPlaying((p) => !p);
            }}
          >
            {playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
          </ControlButton>
          <ControlButton label="Step back" onClick={() => setCursor((c) => Math.max(0, c - 1))}>
            <SkipBack size={13} aria-hidden />
          </ControlButton>
          <ControlButton label="Step forward" onClick={() => setCursor((c) => Math.min(total, c + 1))}>
            <SkipForward size={13} aria-hidden />
          </ControlButton>
          <ControlButton label="Restart" onClick={restart}>
            <RotateCcw size={13} aria-hidden />
          </ControlButton>
        </div>

        <div className="flex items-center gap-1">
          {SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSpeed(option)}
              aria-pressed={speed === option}
              className={cx(
                "mono-label border px-2 py-1 transition-colors",
                speed === option ? "border-a-line bg-a-deep text-a" : "border-line text-dim hover:text-mid",
              )}
            >
              {option}x
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-4">
          <span className="tnum font-mono text-xs text-dim">
            {cursor}/{total} events
          </span>
          <span className="tnum font-mono text-xs text-mid">{fmtMs(current?.t ?? 0)}</span>
        </div>
      </div>

      {/* scrubber */}
      <div className="px-4 py-4">
        <div className="relative">
          <input
            type="range"
            min={0}
            max={total}
            value={cursor}
            aria-label="Replay position"
            onChange={(e) => {
              setPlaying(false);
              setCursor(Number(e.target.value));
            }}
            className="w-full accent-[#e8a33d]"
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1.5" aria-hidden>
            {markerPositions.map((marker, i) => (
              <span
                key={`${marker.t}-${i}`}
                title={marker.label}
                className={cx(
                  "absolute top-0 h-1.5 w-0.5",
                  MARKER_TONE[marker.type] ?? "bg-dim",
                )}
                style={{ left: `${total === 0 ? 0 : (marker.index / total) * 100}%` }}
              />
            ))}
          </div>
        </div>

        {current ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 border border-line bg-surface px-3 py-2.5">
            {current.side ? (
              <Chip tone={current.side === "A" ? "amber" : "cyan"}>Agent {current.side}</Chip>
            ) : (
              <Chip tone="muted">Arena</Chip>
            )}
            <span className="mono-label text-dim">{current.type}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-mid">{current.label}</span>
            {current.durationMs !== undefined ? (
              <span className="tnum font-mono text-xs text-dim">{current.durationMs}ms</span>
            ) : null}
          </div>
        ) : (
          <p className="mono-label mt-4 text-dim">Before the first event</p>
        )}
      </div>

      <EventStream events={visible} height={300} filter={filter} onFilterChange={setFilter} />
    </div>
  );
}

function ControlButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center border border-line text-mid transition-colors hover:border-line-strong hover:text-text"
    >
      {children}
    </button>
  );
}
