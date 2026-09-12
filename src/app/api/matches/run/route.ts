import type { NextRequest } from "next/server";
import { createMatch, MatchError, resolveMode, startMatch } from "@/lib/arena/engine";
import { createMatchSchema } from "@/lib/agents/schema";
import { getMatchDetail } from "@/lib/server/queries";
import { fail, guard, ok, parseBody } from "@/lib/server/api";
import { clientKey, rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Create a match, run it, and return the whole thing in one response.
 *
 * The streaming flow — create, navigate, start, follow over SSE — needs four
 * requests to agree on where the match lives. That holds on one long-lived
 * process and breaks on a serverless host, where each request may land on a
 * different instance and the match exists only in the one that created it. The
 * symptom is the arena page 404ing the moment you press start.
 *
 * This endpoint removes the shared state from the critical path instead of
 * trying to synchronise it: one request creates, runs, grades and returns the
 * recorded events. Nothing about the run changes — the same engine, sandbox,
 * tools and graders execute, and the events are the ones the harness emitted
 * with their measured timings. The client paces them for readability exactly as
 * it paces the live stream.
 *
 * A scripted (DEMO) match finishes in roughly 200ms, so holding the request
 * open costs nothing. A model-driven match can take minutes and belongs on the
 * streaming path, which is why the caller is told to use it instead.
 */
export async function POST(request: NextRequest) {
  return guard(async () => {
    const limited = rateLimit(clientKey(request, "matches:run"), 20, 60_000);
    if (!limited.allowed) {
      return fail("rate_limited", `Too many matches queued. Try again in ${Math.ceil(limited.resetInMs / 1000)}s.`);
    }

    const { data, error } = await parseBody(request, createMatchSchema);
    if (error) return error;

    try {
      const created = await createMatch(data);

      // A live match is unbounded in a way a request is not. Hand it back so the
      // caller can open the stream, rather than holding a connection for minutes
      // and risking a platform timeout mid-run.
      if (created.participants.some((p) => resolveMode(p.configSnapshot) === "live")) {
        return ok({ matchId: created.id, streamInstead: true });
      }

      await startMatch(created.id);

      // MatchDetail already carries the recorded events alongside the grading,
      // so the client needs nothing further to render the whole match.
      const detail = await getMatchDetail(created.id);
      if (!detail) return fail("unprocessable", "The match ran but could not be read back.");

      return ok({ ...detail, streamInstead: false }, { status: 201 });
    } catch (e) {
      if (e instanceof MatchError) {
        return fail(e.code === "not_found" ? "not_found" : "unprocessable", e.message);
      }
      console.error("[arena] run failed:", e);
      throw e;
    }
  });
}
