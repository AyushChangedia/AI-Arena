import type { NextRequest } from "next/server";
import { eventBus, isTerminator, topicFor } from "@/lib/arena/events";
import { getStore } from "@/lib/store";
import { isRunning } from "@/lib/arena/engine";
import { fail, guard } from "@/lib/server/api";
import type { ExecutionEvent } from "@/lib/arena/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
/** How often to re-read the store when the match is running elsewhere. */
const POLL_MS = 500;

/**
 * Server-sent events for one match.
 *
 * A subscriber receives the buffered backlog first and then live events, so a
 * browser that opens the arena mid-match — or reconnects after a drop — sees
 * the whole story rather than joining blind. `lastSeq` lets a reconnecting
 * client skip what it already has.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const store = await getStore();
    const match = await store.getMatch(id);
    if (!match) return fail("not_found", `No match with id "${id}".`);

    const lastSeqParam = Number(
      request.nextUrl.searchParams.get("lastSeq") ?? request.headers.get("last-event-id") ?? "-1",
    );
    const lastSeq = Number.isFinite(lastSeqParam) ? lastSeqParam : -1;

    const bus = eventBus();
    const topic = topicFor(id);
    const encoder = new TextEncoder();

    // A finished match has its trace in the store; a live one has it in the bus.
    const backlog = bus.history(topic);
    const history: ExecutionEvent[] =
      backlog.length > 0 ? backlog : await store.getEvents(id);
    const finished = match.status === "complete" || match.status === "failed";

    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const send = (event: string, data: unknown, eventId?: number) => {
          if (closed) return;
          try {
            const lines = [
              eventId !== undefined ? `id: ${eventId}` : null,
              `event: ${event}`,
              `data: ${JSON.stringify(data)}`,
              "",
              "",
            ]
              .filter((l) => l !== null)
              .join("\n");
            controller.enqueue(encoder.encode(lines));
          } catch {
            closed = true;
          }
        };

        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
          if (poll) clearInterval(poll);
          try {
            controller.close();
          } catch {
            // Already closed by the client disconnecting.
          }
        };

        send("open", {
          matchId: id,
          status: match.status,
          backlog: history.length,
          resumedFrom: lastSeq,
        });

        // One gate for both sources. The local bus and the store poll can both
        // deliver the same event, and a replayed duplicate would be counted
        // twice by every panel downstream.
        let highest = lastSeq;
        const forward = (event: ExecutionEvent) => {
          if (event.seq <= highest) return;
          highest = event.seq;
          send("arena", event, event.seq);
        };

        for (const event of history) forward(event);

        // Nothing more is coming for a finished match, so close rather than
        // holding a connection open forever.
        if (finished && !isRunning(id)) {
          send("end", { matchId: id, status: match.status });
          close();
          return;
        }

        unsubscribe = bus.subscribe(topic, (event) => {
          if (isTerminator(event)) {
            send("end", { matchId: id, status: "complete" });
            close();
            return;
          }
          forward(event);
        });

        // The match may be running on a different instance, whose in-process
        // bus this one cannot see. The engine mirrors events into the store as
        // they happen, so follow it from there instead of holding open a
        // connection that would never deliver anything.
        if (!isRunning(id)) {
          poll = setInterval(() => {
            if (closed) return;
            void (async () => {
              try {
                for (const event of await store.getEvents(id)) forward(event);
                const current = await store.getMatch(id);
                if (current && (current.status === "complete" || current.status === "failed")) {
                  send("end", { matchId: id, status: current.status });
                  close();
                }
              } catch (error) {
                console.error(`[arena] follow failed for ${id}:`, error);
              }
            })();
          }, POLL_MS);
          poll.unref?.();
        }

        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            close();
          }
        }, HEARTBEAT_MS);
        heartbeat.unref?.();

        request.signal.addEventListener("abort", close);
      },

      cancel() {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        if (poll) clearInterval(poll);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}
