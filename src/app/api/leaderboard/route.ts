import type { NextRequest } from "next/server";
import { getLeaderboard } from "@/lib/server/queries";
import { guard, ok } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return guard(async () => {
    const params = request.nextUrl.searchParams;
    const board = await getLeaderboard({
      seasonId: params.get("season") ?? undefined,
      scope: params.get("scope") ?? undefined,
      limit: params.get("limit") ? Number(params.get("limit")) : undefined,
    });
    return ok(board);
  });
}
