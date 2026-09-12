"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentState, ExecutionEvent, MatchStatus, Side } from "@/lib/arena/types";

/**
 * The arena's single realtime connection.
 *
 * One `EventSource` per arena view; every panel on the screen derives from the
 * state this hook reduces. Two things are worth knowing about it:
 *
 * 1. **The stream is genuinely live.** Events are published by the harness at
 *    the moment each thing happens, and the endpoint replays the buffered
 *    backlog before streaming, so opening the page mid-match loses nothing.
 *
 * 2. **Rendering is paced, and says so.** A demo match completes in a fraction
 *    of a second, which is unwatchable. The renderer therefore drains its queue
 *    at a readable cadence and shows how far behind the live edge it is. That
 *    is a presentation choice, exactly like broadcast telemetry — no event is
 *    invented, reordered, or delayed in the data itself, and the speed control
 *    is in the user's hands.
 */

export interface ToolActivity {
  id: string;
  tool: string;
  detail: string;
  status: "pending" | "ok" | "error";
  durationMs: number | null;
  provenance?: string;
  step: number;
}

export interface SideState {
  state: AgentState;
  step: number;
  stepLimit: number | null;
  model: string | null;
  mode: "live" | "demo" | null;
  currentTool: ToolActivity | null;
  recentTools: ToolActivity[];
  toolsCalled: number;
  toolsFailed: number;
  failures: number;
  recoveries: number;
  files: { path: string; bytes: number; kind: "created" | "modified" }[];
  artifactPath: string | null;
  message: string | null;
  /** Why the run ended badly, when it did. Null on a healthy run. */
  failure: { label: string; detail: string | null } | null;
  finished: boolean;
  score: number | null;
}

export interface ArenaState {
  events: ExecutionEvent[];
  sides: Record<Side, SideState>;
  matchStatus: MatchStatus | null;
  result: string | null;
  elapsedMs: number;
}

const emptySide = (): SideState => ({
  state: "idle",
  step: 0,
  stepLimit: null,
  model: null,
  mode: null,
  currentTool: null,
  recentTools: [],
  toolsCalled: 0,
  toolsFailed: 0,
  failures: 0,
  recoveries: 0,
  files: [],
  artifactPath: null,
  message: null,
  failure: null,
  finished: false,
  score: null,
});

const initialState = (): ArenaState => ({
  events: [],
  sides: { A: emptySide(), B: emptySide() },
  matchStatus: null,
  result: null,
  elapsedMs: 0,
});

const MAX_RECENT_TOOLS = 4;
const MAX_RENDERED_EVENTS = 600;

function reduce(state: ArenaState, event: ExecutionEvent): ArenaState {
  const events =
    state.events.length >= MAX_RENDERED_EVENTS
      ? [...state.events.slice(state.events.length - MAX_RENDERED_EVENTS + 1), event]
      : [...state.events, event];

  const next: ArenaState = {
    ...state,
    events,
    elapsedMs: Math.max(state.elapsedMs, event.t),
  };

  if (event.type === "match.started") {
    next.matchStatus = "running";
    return next;
  }
  if (event.type === "eval.started") {
    next.matchStatus = "evaluating";
    return next;
  }
  if (event.type === "match.completed") {
    next.matchStatus = "complete";
    next.result = typeof event.data?.result === "string" ? event.data.result : null;
    return next;
  }
  if (event.type === "eval.dimension" && event.side) {
    const total = event.data?.total;
    next.sides = {
      ...next.sides,
      [event.side]: {
        ...next.sides[event.side],
        score: typeof total === "number" ? total : next.sides[event.side].score,
      },
    };
    return next;
  }

  if (!event.side) return next;

  const side = { ...next.sides[event.side] };
  side.step = Math.max(side.step, event.step);

  switch (event.type) {
    case "agent.started": {
      side.state = "planning";
      side.model = typeof event.data?.model === "string" ? event.data.model : null;
      side.mode = event.data?.mode === "live" ? "live" : "demo";
      side.stepLimit = typeof event.data?.stepLimit === "number" ? event.data.stepLimit : null;
      break;
    }
    case "agent.state_changed": {
      if (event.state) side.state = event.state;
      break;
    }
    case "agent.planning":
      side.state = "planning";
      break;
    case "agent.thinking":
      side.state = "thinking";
      break;
    case "agent.message":
      side.message = event.detail ?? event.label;
      break;
    case "agent.tool_called": {
      side.toolsCalled += 1;
      side.currentTool = {
        id: event.id,
        tool: event.tool ?? "tool",
        detail: event.detail ?? "",
        status: "pending",
        durationMs: null,
        step: event.step,
      };
      break;
    }
    case "agent.tool_completed": {
      const finished: ToolActivity = {
        id: event.id,
        tool: event.tool ?? "tool",
        detail: side.currentTool?.detail ?? event.detail ?? "",
        status: "ok",
        durationMs: event.durationMs ?? null,
        provenance: typeof event.data?.provenance === "string" ? event.data.provenance : undefined,
        step: event.step,
      };
      side.recentTools = [finished, ...side.recentTools].slice(0, MAX_RECENT_TOOLS);
      side.currentTool = null;
      break;
    }
    case "agent.tool_failed": {
      const failed: ToolActivity = {
        id: event.id,
        tool: event.tool ?? "tool",
        detail: event.detail ?? side.currentTool?.detail ?? "",
        status: "error",
        durationMs: event.durationMs ?? null,
        step: event.step,
      };
      side.recentTools = [failed, ...side.recentTools].slice(0, MAX_RECENT_TOOLS);
      side.currentTool = null;
      side.toolsFailed += 1;
      break;
    }
    case "agent.recovery_started":
      side.failures += 1;
      side.state = "recovering";
      break;
    case "agent.recovery_completed":
      side.recoveries += 1;
      break;
    case "agent.file_created":
    case "agent.file_modified": {
      const path = typeof event.data?.path === "string" ? event.data.path : event.label;
      const bytes = typeof event.data?.bytes === "number" ? event.data.bytes : 0;
      const kind = event.type === "agent.file_created" ? "created" : "modified";
      const existing = side.files.findIndex((f) => f.path === path);
      side.files =
        existing >= 0
          ? side.files.map((f, i) => (i === existing ? { path, bytes, kind } : f))
          : [...side.files, { path, bytes, kind }];
      break;
    }
    case "agent.artifact_created":
      side.artifactPath = typeof event.data?.path === "string" ? event.data.path : side.artifactPath;
      break;
    case "agent.task_completed":
      side.state = "succeeded";
      side.finished = true;
      break;
    case "agent.task_failed":
    case "agent.limit_reached": {
      side.state = event.type === "agent.task_failed" ? "failed" : "blocked";
      side.finished = true;
      // Kept, not discarded. A provider failure on the first step leaves no
      // tools, no files and no message, so without this the panel can only say
      // "awaiting first action" about a run that already ended — and the one
      // thing the viewer needs is which of a retired model, a rate limit or a
      // bad key it was.
      side.failure = {
        label: event.label,
        detail: typeof event.detail === "string" && event.detail.trim() ? event.detail : null,
      };
      break;
    }
    default:
      break;
  }

  next.sides = { ...next.sides, [event.side]: side };
  return next;
}

// ─── playback pacing ────────────────────────────────────────────────────────

export type Speed = 1 | 2 | 4 | 0; // 0 = instant, no pacing

/** Readable cadence, accelerated when the renderer falls behind the live edge. */
function drainDelay(backlog: number, speed: Speed): number {
  if (speed === 0) return 0;
  const base = 300;
  const catchUp = backlog > 60 ? 8 : backlog > 30 ? 4 : backlog > 12 ? 2 : 1;
  return Math.max(24, base / (speed * catchUp));
}

export type ConnectionStatus = "idle" | "connecting" | "streaming" | "ended" | "error";

export interface MatchStream {
  state: ArenaState;
  status: ConnectionStatus;
  /** Events received but not yet rendered — how far behind the live edge we are. */
  backlog: number;
  caughtUp: boolean;
  speed: Speed;
  setSpeed: (speed: Speed) => void;
  error: string | null;
  /** True once every received event has been rendered and the stream has ended. */
  finished: boolean;
}

export function useMatchStream(
  matchId: string | null,
  enabled: boolean,
  /**
   * A complete, already-recorded event list. When given, no connection is
   * opened: the events are the whole match, so there is nothing to wait for.
   * Pacing, the speed control and the reducer are untouched, so a recorded
   * match renders exactly as a streamed one — the events carry the timings the
   * harness measured either way. Used by the run-in-one-request flow, which is
   * the only correct shape on a host where the next request may land on a
   * different instance.
   */
  recorded: ExecutionEvent[] | null = null,
): MatchStream {
  const isRecorded = recorded !== null;
  // Seeded at mount rather than pushed in by an effect: a recorded match is
  // handed to this hook complete, so there is no asynchronous arrival to react to.
  const [queue, setQueue] = useState<ExecutionEvent[]>(() => recorded ?? []);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<Speed>(1);
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const seen = useRef(new Set<number>());

  // ── connection ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (isRecorded) return;
    if (!matchId || !enabled) return;

    const source = new EventSource(`/api/matches/${matchId}/events`);
    let closed = false;

    source.addEventListener("open", () => setStatus("streaming"));

    source.addEventListener("arena", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as ExecutionEvent;
        if (seen.current.has(parsed.seq)) return;
        seen.current.add(parsed.seq);
        setQueue((q) => [...q, parsed]);
      } catch {
        // A malformed frame must not kill the stream.
      }
    });

    source.addEventListener("end", () => {
      closed = true;
      setStatus("ended");
      source.close();
    });

    source.onerror = () => {
      if (closed) return;
      // EventSource retries on its own; only surface a hard failure.
      if (source.readyState === EventSource.CLOSED) {
        setStatus("error");
        setError("The event stream dropped. Reload the page to reconnect.");
      }
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [isRecorded, matchId, enabled]);

  // "Connecting" is the absence of an open event, not a separate stored state.
  // A recorded match has already ended by definition — every event is in hand.
  const connectionStatus: ConnectionStatus = isRecorded
    ? "ended"
    : status === "idle" && enabled && matchId
      ? "connecting"
      : status;

  // ── paced rendering ──────────────────────────────────────────────────────
  useEffect(() => {
    if (cursor >= queue.length) return;

    const backlog = queue.length - cursor;
    const delay = drainDelay(backlog, speed);

    const timer = setTimeout(() => {
      if (speed === 0) {
        // Max: drain the whole queue in one pass rather than one per tick.
        for (let i = cursor; i < queue.length; i++) dispatch(queue[i]!);
        setCursor(queue.length);
        return;
      }
      dispatch(queue[cursor]!);
      setCursor((c) => c + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [queue, cursor, speed]);

  const backlog = queue.length - cursor;
  const finished = connectionStatus === "ended" && backlog === 0;
  const setSpeedStable = useCallback((next: Speed) => setSpeed(next), []);

  return useMemo(
    () => ({
      state,
      status: connectionStatus,
      backlog,
      caughtUp: backlog === 0,
      speed,
      setSpeed: setSpeedStable,
      error,
      finished,
    }),
    [state, connectionStatus, backlog, speed, setSpeedStable, error, finished],
  );
}
