import type { ExecutionEvent } from "./types";

/**
 * Match event bus.
 *
 * In-process pub/sub with a bounded ring buffer per match. A subscriber gets
 * the buffered backlog first and then live events, so a browser that opens the
 * arena mid-match sees the whole story rather than joining blind.
 *
 * Single-process by design. The three-method interface is the seam for a Redis
 * or Postgres-LISTEN driver; the harness and the UI would not change.
 */

export type EventListener = (event: ExecutionEvent) => void;

export interface EventBus {
  publish(topic: string, event: ExecutionEvent): void;
  subscribe(topic: string, listener: EventListener): () => void;
  history(topic: string): ExecutionEvent[];
  close(topic: string): void;
  isClosed(topic: string): boolean;
}

const MAX_BUFFER = 4_000;

class InProcessEventBus implements EventBus {
  private buffers = new Map<string, ExecutionEvent[]>();
  private listeners = new Map<string, Set<EventListener>>();
  private closed = new Set<string>();

  publish(topic: string, event: ExecutionEvent): void {
    const buffer = this.buffers.get(topic) ?? [];
    buffer.push(event);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    this.buffers.set(topic, buffer);

    for (const listener of this.listeners.get(topic) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never take down a running match.
      }
    }
  }

  subscribe(topic: string, listener: EventListener): () => void {
    const set = this.listeners.get(topic) ?? new Set();
    set.add(listener);
    this.listeners.set(topic, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(topic);
    };
  }

  history(topic: string): ExecutionEvent[] {
    return [...(this.buffers.get(topic) ?? [])];
  }

  close(topic: string): void {
    this.closed.add(topic);
    for (const listener of this.listeners.get(topic) ?? []) {
      try {
        listener(TERMINATOR);
      } catch {
        // ignored
      }
    }
  }

  isClosed(topic: string): boolean {
    return this.closed.has(topic);
  }

  /** Frees a finished match's buffer once it has been persisted. */
  evict(topic: string): void {
    this.buffers.delete(topic);
    this.listeners.delete(topic);
    this.closed.delete(topic);
  }
}

/**
 * Sentinel published to subscribers when a match stream ends, so an SSE route
 * can close cleanly rather than waiting for a timeout.
 */
export const TERMINATOR: ExecutionEvent = {
  id: "terminator",
  seq: -1,
  matchId: "",
  executionId: null,
  agentId: null,
  side: null,
  type: "match.completed",
  at: 0,
  t: 0,
  step: 0,
  label: "stream closed",
};

export function isTerminator(event: ExecutionEvent): boolean {
  return event.seq === -1 && event.id === "terminator";
}

/**
 * Module state survives hot reloads in dev via globalThis, so a match started
 * before an edit keeps streaming to the page that is watching it.
 */
const GLOBAL_KEY = "__arena_event_bus__";
type BusHolder = { [GLOBAL_KEY]?: InProcessEventBus };

export function eventBus(): EventBus & { evict(topic: string): void } {
  const holder = globalThis as unknown as BusHolder;
  holder[GLOBAL_KEY] ??= new InProcessEventBus();
  return holder[GLOBAL_KEY];
}

export function topicFor(matchId: string): string {
  return `match:${matchId}`;
}
