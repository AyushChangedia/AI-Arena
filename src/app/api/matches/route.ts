import type { NextRequest } from "next/server";
import { createMatch, MatchError } from "@/lib/arena/engine";
import { createMatchSchema } from "@/lib/agents/schema";
import { fail, guard, ok, parseBody } from "@/lib/server/api";
import { clientKey, rateLimit } from "@/lib/server/rate-limit";
import { listRecentMatches } from "@/lib/server/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return guard(async () => {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 20);
    const matches = await listRecentMatches(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20);
    return ok(matches);
  });
}

export async function POST(request: NextRequest) {
  return guard(async () => {
    const limited = rateLimit(clientKey(request, "matches:create"), 30, 60_000);
    if (!limited.allowed) {
      return fail("rate_limited", `Too many matches queued. Try again in ${Math.ceil(limited.resetInMs / 1000)}s.`);
    }

    const { data, error } = await parseBody(request, createMatchSchema);
    if (error) return error;

    try {
      const match = await createMatch(data);
      return ok(match, { status: 201 });
    } catch (e) {
      if (e instanceof MatchError) {
        return fail(e.code === "not_found" ? "not_found" : "unprocessable", e.message);
      }
      throw e;
    }
  });
}
