import type { NextRequest } from "next/server";
import { z } from "zod";
import { getStore, getVoteStore } from "@/lib/store";
import { fail, guard, ok, parseBody } from "@/lib/server/api";
import { clientKey, rateLimit } from "@/lib/server/rate-limit";
import { viewerId } from "@/lib/server/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const voteSchema = z.object({ side: z.enum(["A", "B"]) });

type Params = { params: Promise<{ id: string }> };

/**
 * Human preference on a finished match.
 *
 * Deliberately separate from the score. The automated result is a measurement —
 * assertions that ran, failures that were recovered from — and folding opinion
 * into it would make the number mean two different things at once. This is
 * recorded and displayed alongside, and when the crowd disagrees with the
 * graders that disagreement is the interesting part, not an error to reconcile.
 *
 * One vote per viewer, changeable, keyed on the same identity that owns agents.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  return guard(async () => {
    const { id } = await params;
    const votes = await getVoteStore();
    return ok(await votes.getVotes(id, (await viewerId()) ?? undefined));
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  return guard(async () => {
    const { id } = await params;

    const voter = await viewerId();
    if (!voter) {
      return fail("forbidden", "Could not identify this browser. Enable cookies and try again.");
    }

    const limited = rateLimit(clientKey(request, "matches:vote"), 60, 60_000);
    if (!limited.allowed) {
      return fail("rate_limited", `Too many votes. Try again in ${Math.ceil(limited.resetInMs / 1000)}s.`);
    }

    const { data, error } = await parseBody(request, voteSchema);
    if (error) return error;

    const store = await getStore();
    const match = await store.getMatch(id);
    if (!match) return fail("not_found", `No match with id "${id}".`);
    // Voting on a match still running would be a verdict on something nobody
    // has seen the end of.
    if (match.status !== "complete") {
      return fail("conflict", "This match has not finished yet.");
    }

    const votes = await getVoteStore();
    await votes.castVote(id, voter, data.side);
    await store.flush();

    return ok(await votes.getVotes(id, voter));
  });
}
