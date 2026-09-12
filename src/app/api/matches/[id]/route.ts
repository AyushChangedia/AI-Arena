import type { NextRequest } from "next/server";
import { getMatchDetail } from "@/lib/server/queries";
import { fail, guard, ok } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const detail = await getMatchDetail(id);
    if (!detail) return fail("not_found", `No match with id "${id}".`);
    return ok(detail);
  });
}
