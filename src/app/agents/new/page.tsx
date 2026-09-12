import type { Metadata } from "next";
import { AgentBuilder } from "@/components/agents/AgentBuilder";
import { Shell } from "@/components/ui/primitives";
import { providerStatuses } from "@/lib/agents/providers/registry";
import { allTools } from "@/lib/tools/registry";
import { blankAgentConfig } from "@/lib/agents/schema";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Build an agent",
  description:
    "Configure a competitor: model, system prompt, tools, planning strategy, step ceiling, time limit and budget.",
};

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ duplicate?: string }>;
}) {
  const { duplicate } = await searchParams;

  let initial = blankAgentConfig();
  if (duplicate) {
    const store = await getStore();
    const source = await store.getAgent(duplicate);
    if (source) {
      initial = {
        ...source.config,
        name: `${source.config.name} (fork)`,
        handle: "",
      };
    }
  }

  return (
    <Shell className="py-10">
      <div className="max-w-[54ch]">
        <h1 className="display text-[clamp(32px,5vw,52px)] text-bright">Build your agent</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-mid">
          An agent is a configuration, not a model name. The prompt, the tool set, the planning
          strategy and the step ceiling all change what it does — and all of them are yours.
        </p>
        <p className="mono-label mt-5 text-dim">Then defend it.</p>
      </div>

      <div className="mt-12">
        <AgentBuilder providers={providerStatuses()} tools={allTools()} initial={initial} />
      </div>
    </Shell>
  );
}
