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

    const run = startMatch(id);
    run.catch((e) => {
      console.error(`[arena] match ${id} failed:`, e instanceof MatchError ? e.message : e);
    });

    return ok({ matchId: id, status: "running", alreadyRunning: false }, { status: 202 });
  });
}
