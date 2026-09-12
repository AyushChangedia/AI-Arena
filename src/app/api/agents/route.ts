import type { NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { viewerId } from "@/lib/server/identity";
import { createAgentSchema } from "@/lib/agents/schema";
import { fail, guard, ok, parseBody } from "@/lib/server/api";
import { clientKey, rateLimit } from "@/lib/server/rate-limit";
import { hashOf, id, slugify } from "@/lib/arena/ids";
import type { Agent } from "@/lib/arena/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return guard(async () => {
    const store = await getStore();
    const visibility = request.nextUrl.searchParams.get("visibility");
    const agents = await store.listAgents(
      visibility === "public" || visibility === "private" ? { visibility } : undefined,
    );
    return ok(agents);
  });
}

export async function POST(request: NextRequest) {
  return guard(async () => {
    const limited = rateLimit(clientKey(request, "agents:create"), 20, 60_000);
    if (!limited.allowed) {
      return fail("rate_limited", `Too many agents created. Try again in ${Math.ceil(limited.resetInMs / 1000)}s.`);
    }

    // Established before anything is written: an agent nobody owns can be
    // edited or deleted by anybody.
    const owner = await viewerId();
    if (!owner) {
      return fail("forbidden", "Could not identify this browser. Enable cookies and try again.");
    }

    const { data, error } = await parseBody(request, createAgentSchema);
    if (error) return error;

    const store = await getStore();
    let handle = slugify(data.config.name);
    if (await store.getAgentByHandle(handle)) {
      handle = `${handle}-${Math.random().toString(36).slice(2, 6)}`;
    }

    const config = { ...data.config, handle };
    const now = Date.now();
    const agent: Agent = {
      id: id("agent"),
      ownerId: owner,
      visibility: data.visibility,
      config,
      configHash: hashOf(config),
      createdAt: now,
      updatedAt: now,
      origin: "user",
    };

    await store.createAgent(agent);
    await store.createAgentVersion({
      id: id("ver"),
      agentId: agent.id,
      version: 1,
      config,
      configHash: agent.configHash,
      createdAt: now,
    });
    await store.flush();

    return ok(agent, { status: 201 });
  });
}
