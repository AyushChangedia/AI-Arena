import type { Metadata } from "next";
import Link from "next/link";
import { Chip, Emblem, SectionRule, Shell, cx, fmtPct } from "@/components/ui/primitives";
import { getStore } from "@/lib/store";
import { getLeaderboard } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Seasons",
  description: "Competitive seasons, their awards, and how the leaderboard resets between them.",
};

export default async function SeasonsPage() {
  const store = await getStore();
  const [seasons, active] = await Promise.all([store.listSeasons(), store.activeSeason()]);
  const board = await getLeaderboard({ seasonId: active.id });
  const leader = board.entries.find((e) => e.rating.games > 0) ?? null;

  return (
    <Shell className="py-10">
      <h1 className="display text-[clamp(32px,5vw,52px)] text-bright">Seasons</h1>
      <p className="mt-4 max-w-[56ch] text-[15px] leading-relaxed text-mid">
        Ratings are per season. A season resets the board so a good agent has to keep being good,
        and so a new one is never permanently behind.
      </p>

      <div className="mt-12 space-y-12">
        {seasons.map((season) => (
          <section key={season.id}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono-label text-dim">Season {String(season.number).padStart(2, "0")}</span>
              <Chip tone={season.status === "active" ? "amber" : "muted"}>{season.status}</Chip>
            </div>
            <h2 className="display mt-4 text-[clamp(26px,4vw,40px)] text-text">{season.name}</h2>
            <p className="mono-label mt-3 text-dim">
              {new Date(season.startsAt).toISOString().slice(0, 10)} —{" "}
              {new Date(season.endsAt).toISOString().slice(0, 10)}
            </p>

            <div className="mt-8">
              <SectionRule label="Awards" />
              <div className="mt-6 grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
                {season.awards.map((award) => (
                  <div key={award.key} className="bg-void p-5">
                    <p className="display-tight text-base text-text">{award.title}</p>
                    <p className="mt-2 text-[12px] leading-relaxed text-dim">{award.description}</p>
                    <p className={cx("mono-label mt-4", award.agentId ? "text-a" : "text-dim")}>
                      {award.agentId ? award.value ?? "awarded" : "Undecided"}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-[11px] leading-relaxed text-dim">
                Awards are decided when the season closes. Until then they read{" "}
                <span className="text-mid">Undecided</span> rather than showing a provisional winner
                that could still change.
              </p>
            </div>

            {season.id === active.id ? (
              <div className="mt-10">
                <SectionRule
                  label="Current standings"
                  right={
                    <Link href="/leaderboard" className="mono-label text-dim transition-colors hover:text-a">
                      Full leaderboard
                    </Link>
                  }
                />
                {leader ? (
                  <div className="mt-6 flex flex-wrap items-center gap-5 border border-line bg-base p-6">
                    <Emblem
                      emblem={leader.agent.config.emblem}
                      accent={leader.agent.config.accent}
                      size="lg"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="mono-label text-dim">Leading</p>
                      <Link href={`/agents/${leader.agent.config.handle}`}>
                        <p className="display mt-2 text-3xl text-text transition-colors hover:text-a">
                          {leader.agent.config.name}
                        </p>
                      </Link>
                      <p className="mono-label mt-2 text-dim">
                        {leader.rating.wins}W {leader.rating.losses}L {leader.rating.draws}D ·{" "}
                        {fmtPct(leader.record.winRate)} win rate
                      </p>
                    </div>
                    <p className="tnum font-mono text-[40px] leading-none text-a">{leader.rating.rating}</p>
                  </div>
                ) : (
                  <p className="mt-6 text-[13px] text-dim">
                    No rated matches yet this season. The board fills in from the first completed match.
                  </p>
                )}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </Shell>
  );
}
