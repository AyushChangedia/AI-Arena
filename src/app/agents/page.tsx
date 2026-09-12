import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, Chip, Emblem, SectionRule, Shell, fmtPct, fmtScore } from "@/components/ui/primitives";
import { getStore } from "@/lib/store";
import { getAgentRecord } from "@/lib/server/queries";
import { resolveMode } from "@/lib/arena/engine";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agents",
  description: "The roster. Every agent is a configuration — model, prompt, tools, planning, limits.",
};

export default async function AgentsPage() {
  const store = await getStore();
  const agents = await store.listAgents();
  const records = await Promise.all(agents.map((a) => getAgentRecord(a.id)));

  const mine = agents.filter((a) => a.origin === "user");
  const seeded = agents.filter((a) => a.origin === "seed");

  return (
    <Shell className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="display text-[clamp(32px,5vw,52px)] text-bright">Agents</h1>
          <p className="mt-4 max-w-[54ch] text-[15px] leading-relaxed text-mid">
            An agent is a model plus a system prompt plus a tool set plus a planning strategy plus
            limits. Change any one of those and you have a different competitor.
          </p>
        </div>
        <ButtonLink href="/agents/new" tone="primary">
          Build an agent
        </ButtonLink>
      </div>

      {mine.length > 0 ? (
        <section className="mt-12">
          <SectionRule label="Your agents" right={<span className="mono-label text-dim">{mine.length}</span>} />
          <Roster agents={mine} records={records} agentsAll={agents} />
        </section>
      ) : null}

      <section className="mt-12">
        <SectionRule label="Seeded roster" right={<span className="mono-label text-dim">{seeded.length}</span>} />
        <p className="mt-4 max-w-[62ch] text-[13px] leading-relaxed text-dim">
          These six are the baseline the arena ships with. They are not equally good and they do not
          all win — the Speedrunner posts the best efficiency numbers in the arena and loses coding
          matches it could have taken.
        </p>
        <Roster agents={seeded} records={records} agentsAll={agents} />
      </section>
    </Shell>
  );
}

function Roster({
  agents,
  records,
  agentsAll,
}: {
  agents: Awaited<ReturnType<Awaited<ReturnType<typeof getStore>>["listAgents"]>>;
  records: Awaited<ReturnType<typeof getAgentRecord>>[];
  agentsAll: Awaited<ReturnType<Awaited<ReturnType<typeof getStore>>["listAgents"]>>;
}) {
  return (
    <div className="mt-6 grid gap-px bg-line md:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => {
        const record = records[agentsAll.findIndex((a) => a.id === agent.id)]!;
        const mode = resolveMode(agent.config);
        return (
          <Link
            key={agent.id}
            href={`/agents/${agent.config.handle}`}
            className="group flex flex-col gap-4 bg-void p-6 transition-colors hover:bg-base"
          >
            <div className="flex items-start gap-3">
              <Emblem emblem={agent.config.emblem} accent={agent.config.accent} size="md" />
              <div className="min-w-0 flex-1">
                <h2 className="display-tight truncate text-lg text-text group-hover:text-a">
                  {agent.config.name}
                </h2>
                <p className="mono-label mt-1 truncate text-dim">{agent.config.model.label}</p>
              </div>
              {mode === "demo" ? (
                <Chip
                  tone="muted"
                  title={`${agent.config.model.label} is not configured, so this agent runs a scripted policy and its matches are labelled DEMO.`}
                >
                  Demo
                </Chip>
              ) : (
                <Chip tone="cyan">Live</Chip>
              )}
            </div>

            <p className="text-[13px] leading-relaxed text-dim">{agent.config.tagline}</p>

            <dl className="mt-auto grid grid-cols-3 gap-px bg-line">
              <Cell label="Rec" value={record.matches === 0 ? null : `${record.wins}-${record.losses}`} />
              <Cell label="Win" value={fmtPct(record.winRate)} />
              <Cell label="Avg" value={fmtScore(record.avgScore)} />
            </dl>

            <p className="mono-label text-dim">
              {agent.config.planning} · {agent.config.maxSteps} steps · {agent.config.tools.length} tools
            </p>
          </Link>
        );
      })}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bg-void px-2.5 py-2.5">
      <dt className="mono-label text-dim">{label}</dt>
      <dd className={`tnum mt-1 font-mono text-[13px] ${value === null || value === "—" ? "text-dim" : "text-mid"}`}>
        {value ?? "—"}
      </dd>
    </div>
  );
}
