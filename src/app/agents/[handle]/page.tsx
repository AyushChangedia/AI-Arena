import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ButtonLink,
  Chip,
  Emblem,
  Meter,
  ModeChip,
  SectionRule,
  Shell,
  Stat,
  cx,
  fmtMs,
  fmtPct,
  fmtRelative,
  fmtScore,
  fmtUsd,
} from "@/components/ui/primitives";
import { getAgentProfile } from "@/lib/server/queries";
import { getTask } from "@/lib/tasks";
import { getToolSpec } from "@/lib/tools/registry";
import { resolveMode } from "@/lib/arena/engine";
import { deriveProfile } from "@/lib/agents/policies/types";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const profile = await getAgentProfile(handle);
  if (!profile) return { title: "Agent not found" };
  return {
    title: profile.agent.config.name,
    description: profile.agent.config.tagline || profile.agent.config.description,
  };
}

export default async function AgentProfilePage({ params }: Props) {
  const { handle } = await params;
  const profile = await getAgentProfile(handle);
  if (!profile) notFound();

  const { agent, record, ratings, recentMatches } = profile;
  const config = agent.config;
  const mode = resolveMode(config);
  const overall = ratings.find((r) => r.scope === "overall");
  const byCategory = ratings.filter((r) => r.scope !== "overall");
  // The same derivation the engine uses, shown so demo behaviour is inspectable.
  const policyProfile = deriveProfile(config, "profile-preview");

  return (
    <Shell className="py-10">
      {/* identity */}
      <div className="flex flex-wrap items-start gap-6">
        <Emblem emblem={config.emblem} accent={config.accent} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="muted">{agent.origin === "seed" ? "Seeded" : "Yours"}</Chip>
            <ModeChip mode={mode} />
            <Chip tone="muted">{agent.visibility === "public" ? "Public" : "Private"}</Chip>
          </div>
          <h1 className="display mt-4 text-[clamp(30px,5vw,52px)] text-bright">{config.name}</h1>
          <p className="mono-label mt-2 text-dim">
            @{config.handle} · {config.model.label}
          </p>
          {config.tagline ? <p className="mt-4 max-w-[52ch] text-[15px] text-mid">{config.tagline}</p> : null}
        </div>
        <div className="text-right">
          <p className="mono-label text-dim">Rating</p>
          <p className={cx("tnum font-mono text-[44px] leading-none", overall ? "text-a" : "text-dim")}>
            {overall?.rating ?? "—"}
          </p>
          <p className="mono-label mt-2 text-dim">
            {overall ? `peak ${overall.peak}` : "unrated"}
          </p>
        </div>
      </div>

      {mode === "demo" ? (
        <p className="mt-6 border border-line bg-base px-4 py-3 text-[13px] leading-relaxed text-dim">
          This agent is configured for <span className="text-mid">{config.model.label}</span>, which is
          not currently connected. Its matches run a deterministic scripted policy through the real
          execution engine and are labelled <span className="text-mid">DEMO</span>. Nothing here claims
          {" "}{config.model.label} produced those runs.
        </p>
      ) : null}

      {config.description ? (
        <p className="mt-8 max-w-[68ch] text-[15px] leading-relaxed text-mid">{config.description}</p>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink href="/arena" tone="primary">
          Challenge this agent
        </ButtonLink>
        {agent.origin === "user" ? <ButtonLink href={`/agents/new?duplicate=${agent.id}`}>Duplicate</ButtonLink> : null}
        {agent.origin === "seed" ? (
          <ButtonLink href={`/agents/new?duplicate=${agent.id}`}>Fork this build</ButtonLink>
        ) : null}
      </div>

      {/* record */}
      <div className="mt-12">
        <SectionRule label="Record" />
        <dl className="mt-6 grid gap-6 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Matches" value={record.matches || null} hint="none yet" />
          <Stat label="Record" value={record.matches ? `${record.wins}-${record.losses}-${record.draws}` : null} />
          <Stat label="Win rate" value={fmtPct(record.winRate)} tone="amber" />
          <Stat label="Avg score" value={fmtScore(record.avgScore)} />
          <Stat label="Success" value={fmtPct(record.successRate)} hint="runs that finished cleanly" />
          <Stat label="Recovery" value={fmtPct(record.recoveryRate)} hint="no failures yet" />
        </dl>
        <dl className="mt-8 grid gap-6 sm:grid-cols-3">
          <Stat label="Avg cost" value={fmtUsd(record.avgCostUsd)} hint="no provider reported a cost" />
          <Stat label="Avg duration" value={fmtMs(record.avgDurationMs)} />
          <Stat label="Demo share" value={fmtPct(record.demoShare)} hint="no matches yet" />
        </dl>
        {record.matches === 0 ? (
          <p className="mt-6 text-[13px] text-dim">
            This agent has not competed yet. Every figure above stays an em-dash until it does —
            nothing here is estimated or seeded.
          </p>
        ) : null}
      </div>

      {/* category ratings */}
      {byCategory.length > 0 ? (
        <div className="mt-12">
          <SectionRule label="By category" />
          <ul className="mt-6 divide-y divide-line border-y border-line">
            {byCategory.map((rating) => (
              <li key={rating.scope} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
                <Link
                  href={`/leaderboard?scope=${rating.scope}`}
                  className="mono-label w-28 shrink-0 text-dim transition-colors hover:text-a"
                >
                  {rating.scope}
                </Link>
                <span className="tnum w-16 font-mono text-sm text-a">{rating.rating}</span>
                <span className="tnum font-mono text-xs text-dim">
                  {rating.wins}W {rating.losses}L {rating.draws}D
                </span>
                <span className="min-w-[120px] flex-1">
                  <Meter value={rating.games === 0 ? null : rating.wins / rating.games} tone="amber" />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* configuration */}
      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section>
          <SectionRule label="System prompt" />
          <pre className="mt-6 overflow-x-auto border border-line bg-base p-5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-mid">
            {config.systemPrompt}
          </pre>
          <p className="mt-3 text-[11px] text-dim">
            Config hash <span className="font-mono text-mid">{agent.configHash}</span> — every match this
            agent ran is pinned to the exact configuration it ran with.
          </p>
        </section>

        <aside className="space-y-10">
          <section>
            <SectionRule label="Configuration" />
            <dl className="mt-5 grid grid-cols-2 gap-px bg-line">
              <Fact label="Planning" value={config.planning} />
              <Fact label="Memory" value={config.memory} />
              <Fact label="Max steps" value={String(config.maxSteps)} />
              <Fact label="Time limit" value={`${Math.round(config.timeLimitMs / 1000)}s`} />
              <Fact label="Budget" value={`$${config.budgetUsd.toFixed(2)}`} />
              <Fact label="Temperature" value={config.temperature === null ? "default" : String(config.temperature)} />
            </dl>
          </section>

          <section>
            <SectionRule label="Tools" right={<span className="mono-label text-dim">{config.tools.length}</span>} />
            <ul className="mt-5 space-y-2">
              {config.tools.map((name) => {
                const spec = getToolSpec(name);
                return (
                  <li key={name} className="border border-line bg-base px-3 py-2">
                    <p className="mono-label text-mid">{name}</p>
                    {spec ? <p className="mt-1 text-[11px] text-dim">{spec.permission}</p> : null}
                  </li>
                );
              })}
            </ul>
          </section>

          {mode === "demo" ? (
            <section>
              <SectionRule label="Demo policy profile" />
              <p className="mt-5 text-[12px] leading-relaxed text-dim">
                Derived from this agent&rsquo;s own configuration, so how you build it really does change
                how it behaves in demo mode.
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-px bg-line">
                <Fact label="Explore" value={`${policyProfile.explore} extra steps`} />
                <Fact label="Approach" value={policyProfile.careful ? "careful" : "quick"} />
                <Fact label="Verifies" value={policyProfile.verifies ? "yes" : "no"} />
                <Fact label="Recovers" value={`${policyProfile.recovers}x`} />
              </dl>
            </section>
          ) : null}
        </aside>
      </div>

      {/* matches */}
      <div className="mt-12">
        <SectionRule label="Recent matches" />
        {recentMatches.length === 0 ? (
          <p className="mt-6 text-[13px] text-dim">No matches yet.</p>
        ) : (
          <ul className="mt-6 divide-y divide-line border-y border-line">
            {recentMatches.map((match) => {
              const participant = match.participants.find((p) => p.agentId === agent.id)!;
              const opponent = match.participants.find((p) => p.agentId !== agent.id)!;
              const outcome =
                match.status !== "complete"
                  ? match.status
                  : match.result === "draw"
                    ? "draw"
                    : match.result === participant.side
                      ? "win"
                      : "loss";
              const task = getTask(match.taskId);
              return (
                <li key={match.id}>
                  <Link
                    href={
                      match.status === "complete" || match.status === "failed"
                        ? `/matches/${match.id}`
                        : `/arena/${match.id}`
                    }
                    className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3 transition-colors hover:bg-base"
                  >
                    <span
                      className={cx(
                        "mono-label w-12 shrink-0",
                        outcome === "win" ? "text-ok" : outcome === "loss" ? "text-fail" : "text-dim",
                      )}
                    >
                      {outcome === "win" ? "WIN" : outcome === "loss" ? "LOSS" : outcome.toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-mid">
                      vs {opponent.configSnapshot.name}
                    </span>
                    <span className="hidden max-w-[22ch] truncate text-[12px] text-dim sm:block">
                      {task?.title ?? "—"}
                    </span>
                    <span className="tnum font-mono text-[13px] text-mid">
                      {fmtScore(participant.scoreTotal)}
                      <span className="px-1 text-dim">:</span>
                      {fmtScore(opponent.scoreTotal)}
                    </span>
                    <span className="mono-label w-16 text-right text-dim">{fmtRelative(match.createdAt)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Shell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-void px-3 py-3">
      <dt className="mono-label text-dim">{label}</dt>
      <dd className="tnum mt-1 truncate font-mono text-[13px] text-mid">{value}</dd>
    </div>
  );
}
