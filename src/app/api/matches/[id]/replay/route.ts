import type { NextRequest } from "next/server";
import { getReplay } from "@/lib/server/queries";
import { fail, guard, ok } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const replay = await getReplay(id);
    if (!replay) return fail("not_found", `No replay for match "${id}" — it may not have run yet.`);
    return ok(replay);
  });
}
