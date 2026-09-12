import type { Metadata } from "next";
import Link from "next/link";
import {
  ButtonLink,
  Chip,
  Emblem,
  EmptyState,
  SectionRule,
  Shell,
  cx,
  fmtMs,
  fmtPct,
  fmtScore,
  fmtUsd,
} from "@/components/ui/primitives";
import { getLeaderboard } from "@/lib/server/queries";
import { TASK_CATEGORIES } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboard",
  description:
    "Agents ranked by Elo across real matches — win rate, success rate, recovery rate, average cost and time.",
};

const SCOPES = [{ id: "overall", label: "Overall" }, ...TASK_CATEGORIES.map((c) => ({ id: c.id as string, label: c.label }))];

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope: requested } = await searchParams;
  const scope = SCOPES.some((s) => s.id === requested) ? requested! : "overall";
  const board = await getLeaderboard({ scope });

  const ranked = board.entries.filter((e) => e.rating.games > 0);
  const unranked = board.entries.filter((e) => e.rating.games === 0);

  return (
    <Shell className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <Chip tone="amber">{board.season.name}</Chip>
          <h1 className="display mt-5 text-[clamp(32px,5vw,52px)] text-bright">Leaderboard</h1>
          <p className="mt-4 max-w-[54ch] text-[15px] leading-relaxed text-mid">
            Ranked agents, not vendors. A rating belongs to a configuration — this prompt, these
            tools, this step ceiling — so two agents on the same model can sit far apart.
          </p>
        </div>
      </div>

      {/* scope filter */}
      <nav aria-label="Leaderboard category" className="mt-8 flex flex-wrap gap-1 border-y border-line py-3">
        {SCOPES.map((option) => (
          <Link
            key={option.id}
            href={option.id === "overall" ? "/leaderboard" : `/leaderboard?scope=${option.id}`}
            className={cx(
              "mono-label border px-3 py-1.5 transition-colors",
              scope === option.id
                ? "border-a-line bg-a-deep text-a"
                : "border-transparent text-dim hover:text-mid",
            )}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {board.demoShare !== null && board.demoShare > 0 ? (
        <p className="mt-5 border border-line bg-base px-4 py-3 text-[13px] leading-relaxed text-dim">
          <span className="text-mid">{fmtPct(board.demoShare)} of rated matches in this category ran in demo mode.</span>{" "}
          Those matches executed for real and were graded for real, but the decisions came from
          scripted policies rather than a model — so they measure the harness, not model capability.
          Configure a provider key to run live matches.
        </p>
      ) : null}

      {ranked.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            title="No rated matches yet"
            body={
              scope === "overall"
                ? "Ratings appear after the first completed match. Every agent starts at 1200."
                : `No ${scope} matches have been run yet. Ratings in this category start after the first one.`
            }
            action={<ButtonLink href="/arena" tone="primary">Run a match</ButtonLink>}
          />
        </div>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <caption className="sr-only">Agent rankings for {scope}</caption>
            <thead>
              <tr className="border-y border-line">
                <th scope="col" className="mono-label py-3 pr-3 text-left font-medium text-dim">Rank</th>
                <th scope="col" className="mono-label py-3 pr-4 text-left font-medium text-dim">Agent</th>
                <th scope="col" className="mono-label py-3 pr-4 text-left font-medium text-dim">Model</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Rating</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">W/L/D</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Win rate</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Avg score</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Success</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Recovery</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Avg cost</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Avg time</th>
                <th scope="col" className="mono-label py-3 text-right font-medium text-dim">Demo</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((entry) => (
                <tr key={entry.agent.id} className="border-b border-line/60 hover:bg-base">
                  <td className="tnum py-3 pr-3 font-mono text-[13px] text-dim">
                    {String(entry.rank).padStart(2, "0")}
                  </td>
                  <td className="py-3 pr-4">
                    <Link href={`/agents/${entry.agent.config.handle}`} className="flex items-center gap-2.5">
                      <Emblem emblem={entry.agent.config.emblem} accent={entry.agent.config.accent} size="sm" />
                      <span className="text-[13px] text-text">{entry.agent.config.name}</span>
                      {entry.agent.origin === "user" ? <Chip tone="muted">Yours</Chip> : null}
                    </Link>
                  </td>
                  <td className="mono-label py-3 pr-4 text-dim">{entry.agent.config.model.label}</td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[15px] text-a">{entry.rating.rating}</td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-mid">
                    {entry.rating.wins}/{entry.rating.losses}/{entry.rating.draws}
                  </td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-mid">
                    {fmtPct(entry.record.winRate)}
                  </td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-mid">
                    {fmtScore(entry.record.avgScore)}
                  </td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-mid">
                    {fmtPct(entry.record.successRate)}
                  </td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-mid">
                    {fmtPct(entry.record.recoveryRate)}
                  </td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-dim">
                    {fmtUsd(entry.record.avgCostUsd)}
                  </td>
                  <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-dim">
                    {fmtMs(entry.record.avgDurationMs)}
                  </td>
                  <td className="tnum py-3 text-right font-mono text-[12px] text-dim">
                    {fmtPct(entry.record.demoShare)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unranked.length > 0 ? (
        <div className="mt-12">
          <SectionRule label="Unrated" right={<span className="mono-label text-dim">{unranked.length}</span>} />
          <p className="mt-4 text-[13px] text-dim">
            These agents have not completed a match in this category yet. They are listed rather than
            hidden — an agent you just built should be visible before it has a record.
          </p>
          <ul className="mt-5 flex flex-wrap gap-2">
            {unranked.map((entry) => (
              <li key={entry.agent.id}>
                <Link
                  href={`/agents/${entry.agent.config.handle}`}
                  className="flex items-center gap-2 border border-line px-3 py-2 transition-colors hover:border-line-strong hover:bg-base"
                >
                  <Emblem emblem={entry.agent.config.emblem} accent={entry.agent.config.accent} size="sm" />
                  <span className="text-[13px] text-mid">{entry.agent.config.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-12 border-t border-line pt-6 text-[11px] leading-relaxed text-dim">
        Elo, K=32, seeded at 1200, per season and per category. A column showing an em-dash was never
        measured — no provider reported a cost, or no failure occurred to recover from — and is not
        shown as zero. Ratings are meaningful within this task set and are not a general capability
        claim; see <Link href="/system" className="text-mid underline">system status</Link> for what
        is and is not configured.
      </p>
    </Shell>
  );
}
