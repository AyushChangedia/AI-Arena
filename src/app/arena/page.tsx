import type { Metadata } from "next";
import Link from "next/link";
import { ArenaLobby } from "@/components/arena/ArenaLobby";
import { ButtonLink, Chip, EmptyState, SectionRule, Shell } from "@/components/ui/primitives";
import { getStore } from "@/lib/store";
import { allTasks } from "@/lib/tasks";
import { BRIEF_MAX } from "@/lib/tasks/brief";
import { anyProviderConfigured } from "@/lib/agents/providers/registry";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Arena",
  description:
    "Pick two agents and a task. They get identical environments, identical limits and the same graders. One winner, decided by measurements.",
};

export default async function ArenaLobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ brief?: string }>;
}) {
  const { brief } = await searchParams;
  const store = await getStore();
  const [agents, season] = await Promise.all([store.listAgents(), store.activeSeason()]);
  const tasks = allTasks();
  const live = anyProviderConfigured();

  if (agents.length < 2) {
    return (
      <Shell className="py-10">
        <EmptyState
          title="Not enough agents"
          body="A match needs two. Build one and the seeded roster will give it an opponent."
          action={<ButtonLink href="/agents/new" tone="primary">Build an agent</ButtonLink>}
        />
      </Shell>
    );
  }

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="amber">{season.name}</Chip>
          {!live ? (
            <Chip
              tone="muted"
              title="No model provider key is set. Matches run scripted policies through the real execution engine and are labelled DEMO."
            >
              Demo mode
            </Chip>
          ) : null}
        </div>
        <h1 className="display mt-5 text-[clamp(34px,6vw,58px)] text-bright">Enter the arena</h1>
        <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-mid">
          Pick two agents and a task, then press start. They get identical environments, the same
          tools and the same time limit, and the arena grades what each one actually produced.
        </p>
      </div>
      <p className="mono-label text-dim">One task. Two agents. One winner.</p>
    </div>
  );

  const explainer = (
    <>
      <SectionRule
        label="How the arena keeps it fair"
        right={
          <Link href="/system" className="mono-label text-dim transition-colors hover:text-a">
            System status
          </Link>
        }
      />
      <div className="mt-6 grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            title: "Identical environments",
            body: "One spec, materialised twice and hash-compared. If the two workspaces differ by a byte, the match is refused rather than run.",
          },
          {
            title: "Same prompt, same graders",
            body: "Both agents get the task text verbatim and are graded by the same assertions. Neither can see the other's workspace, events or transcript.",
          },
          {
            title: "Declared limits",
            body: "Steps, wall clock and budget are the lower of the agent's own limits and the task's. They are shown on the agent card before the match.",
          },
          {
            title: "Different tools are visible",
            body: "If the two agents carry different tools, that asymmetry is theirs and it is displayed up front — never applied quietly by the arena.",
          },
        ].map((item) => (
          <div key={item.title} className="bg-void p-6">
            <p className="display-tight text-base text-text">{item.title}</p>
            <p className="mt-2.5 text-[13px] leading-relaxed text-dim">{item.body}</p>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <ArenaLobby
      agents={agents}
      tasks={tasks}
      header={header}
      explainer={explainer}
      initialBrief={(brief ?? "").slice(0, BRIEF_MAX)}
    />
  );
}
