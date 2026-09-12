import type { NextRequest } from "next/server";
import { isRunning, MatchError, startMatch } from "@/lib/arena/engine";
import { getStore } from "@/lib/store";
import { fail, guard, ok } from "@/lib/server/api";
import { clientKey, rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Starts a match and returns immediately. The run continues in the background
 * and the client follows it over SSE at /api/matches/:id/events — which replays
 * the buffered backlog first, so nothing is missed in the gap.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const limited = rateLimit(clientKey(request, "matches:start"), 30, 60_000);
    if (!limited.allowed) {
      return fail("rate_limited", `Too many matches started. Try again in ${Math.ceil(limited.resetInMs / 1000)}s.`);
    }

    const store = await getStore();
    const match = await store.getMatch(id);
    if (!match) return fail("not_found", `No match with id "${id}".`);

    if (isRunning(id)) return ok({ matchId: id, status: "running", alreadyRunning: true });
    if (match.status !== "pending") {
      return fail("conflict", `Match #${match.number} has already run. Create a new match to run it again.`);
    }

    // Awaited, not fire-and-forget.
    //
    // A serverless host terminates the function as soon as the response is
    // sent, which would kill a match mid-run. The client opens the event stream
    // *before* calling this endpoint, so awaiting here costs nothing: the run is
    // already being watched live while this request is still in flight.
    try {
      const finished = await startMatch(id);
      return ok({
        matchId: id,
        status: finished.status,
        result: finished.result,
        alreadyRunning: false,
      });
    } catch (e) {
      const message = e instanceof MatchError ? e.message : "The match could not be completed.";
      console.error(`[arena] match ${id} failed:`, e);
      return fail("unprocessable", message);
    }
  });
}
