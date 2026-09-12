import { providerStatuses } from "@/lib/agents/providers/registry";
import { createSearchBackend } from "@/lib/tools/web";
import { codeExecutor } from "@/lib/sandbox/vm";
import { guard, ok } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Booleans and labels only. No key material, and nothing that hints at the
 * shape or length of a key.
 */
export async function GET() {
  return guard(async () => {
    const search = createSearchBackend();
    const executor = codeExecutor();
    return ok({
      providers: providerStatuses(),
      search: { id: search.id, label: search.label, provenance: search.provenance },
      sandbox: {
        id: executor.id,
        available: executor.available,
        unavailableReason: executor.unavailableReason,
      },
    });
  });
}
