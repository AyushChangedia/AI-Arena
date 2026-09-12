import { getStore } from "@/lib/store";
import { guard, ok } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const store = await getStore();
    const [seasons, active] = await Promise.all([store.listSeasons(), store.activeSeason()]);
    return ok({ seasons, activeSeasonId: active.id });
  });
}
