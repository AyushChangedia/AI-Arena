import type { NextRequest } from "next/server";
import { eventBus, isTerminator, topicFor } from "@/lib/arena/events";
import { getStore } from "@/lib/store";
import { isRunning } from "@/lib/arena/engine";
import { fail, guard } from "@/lib/server/api";
import type { ExecutionEvent } from "@/lib/arena/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

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

        for (const event of history) {
          if (event.seq <= lastSeq) continue;
          send("arena", event, event.seq);
        }

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
          if (event.seq <= lastSeq) return;
          send("arena", event, event.seq);
        });

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
