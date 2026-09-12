import { storeStatus } from "@/lib/store";
import { anyProviderConfigured, providerStatuses } from "@/lib/agents/providers/registry";
import { createSearchBackend } from "@/lib/tools/web";
import { codeExecutor } from "@/lib/sandbox/vm";
import { allTasks } from "@/lib/tasks";
import { allTools } from "@/lib/tools/registry";
import { getArenaStats } from "@/lib/server/queries";
import { guard, ok } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything an operator needs to know about what is and is not real here. */
export async function GET() {
  return guard(async () => {
    const [store, stats] = await Promise.all([storeStatus(), getArenaStats()]);
    const executor = codeExecutor();
    const search = createSearchBackend();

    return ok({
      mode: anyProviderConfigured() ? "live-capable" : "demo-only",
      providers: providerStatuses().map((p) => ({ id: p.id, label: p.label, configured: p.configured, envVar: p.envVar })),
      sandbox: {
        id: executor.id,
        available: executor.available,
        unavailableReason: executor.unavailableReason,
        note: "node:vm removes host bindings and enforces a wall-clock timeout. It is a restriction layer, not an isolation boundary — see docs/ARCHITECTURE.md.",
      },
      search: { id: search.id, label: search.label, provenance: search.provenance },
      persistence: {
        driver: store.driver,
        persistent: store.persistent,
        // Whether a second instance sees the same data — the difference that
        // decides if the leaderboard is a record or just this process's memory.
        shared: store.shared,
        location: store.location,
        note: !store.persistent
          ? "Snapshots are not reaching disk; this process is memory-only."
          : store.shared
            ? undefined
            : "Single-process storage. Set DATABASE_URL to share state across instances and survive restarts.",
      },
      catalogue: { tasks: allTasks().length, tools: allTools().length },
      stats,
    });
  });
}
