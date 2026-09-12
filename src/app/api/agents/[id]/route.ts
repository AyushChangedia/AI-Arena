import type { NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { updateAgentSchema } from "@/lib/agents/schema";
import { fail, guard, ok, parseBody } from "@/lib/server/api";
import { getAgentProfile } from "@/lib/server/queries";
import { hashOf, id } from "@/lib/arena/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  return guard(async () => {
    const { id: agentId } = await params;
    const profile = await getAgentProfile(agentId);
    if (!profile) return fail("not_found", `No agent with id or handle "${agentId}".`);
    return ok(profile);
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return guard(async () => {
    const { id: agentId } = await params;
    const store = await getStore();
    const agent = await store.getAgent(agentId);
    if (!agent) return fail("not_found", `No agent with id "${agentId}".`);
    if (agent.origin === "seed") {
      return fail("conflict", "Seed agents are immutable — duplicate one into your own agent to change it.");
    }

    const { data, error } = await parseBody(request, updateAgentSchema);
    if (error) return error;

    const config = { ...agent.config, ...data.config, handle: agent.config.handle };
    const updated = {
      ...agent,
      config,
      configHash: hashOf(config),
      visibility: data.visibility ?? agent.visibility,
      updatedAt: Date.now(),
    };

    // A new version, not an overwrite: past matches keep the config they ran.
    const versions = await store.listAgentVersions(agent.id);
    await store.createAgentVersion({
      id: id("ver"),
      agentId: agent.id,
      version: (versions[0]?.version ?? 0) + 1,
      config,
      configHash: updated.configHash,
      createdAt: updated.updatedAt,
    });
    await store.updateAgent(updated);
    await store.flush();

    return ok(updated);
  });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  return guard(async () => {
    const { id: agentId } = await params;
    const store = await getStore();
    const agent = await store.getAgent(agentId);
    if (!agent) return fail("not_found", `No agent with id "${agentId}".`);
    if (agent.origin === "seed") {
      return fail("conflict", "Seed agents cannot be deleted — they are the arena's baseline roster.");
    }
    await store.deleteAgent(agentId);
    await store.flush();
    return ok({ deleted: true });
  });
}
