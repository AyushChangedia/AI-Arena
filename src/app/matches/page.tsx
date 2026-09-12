import type { Metadata } from "next";
import Link from "next/link";
import {
  ButtonLink,
  Chip,
  Emblem,
  EmptyState,
  ModeChip,
  Shell,
  cx,
  fmtMs,
  fmtRelative,
  fmtScore,
} from "@/components/ui/primitives";
import { listRecentMatches } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Matches",
  description: "Every match run in the arena, with the score, the task and a full replay.",
};

export default async function MatchesPage() {
  const matches = await listRecentMatches(60);

  return (
    <Shell className="py-10">
      <h1 className="display text-[clamp(32px,5vw,52px)] text-bright">Matches</h1>
      <p className="mt-4 max-w-[56ch] text-[15px] leading-relaxed text-mid">
        Every run is kept in full: the event trace, the artifacts, the assertions and the score maths.
        A result you cannot inspect is a result you should not trust.
      </p>

      {matches.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            title="Nothing has run yet"
            body="The arena keeps no fixtures and no sample data. The first row here will be a match you ran."
            action={<ButtonLink href="/arena" tone="primary">Run a match</ButtonLink>}
          />
        </div>
      ) : (
        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-y border-line">
                <th scope="col" className="mono-label py-3 pr-4 text-left font-medium text-dim">#</th>
                <th scope="col" className="mono-label py-3 pr-4 text-left font-medium text-dim">Agents</th>
                <th scope="col" className="mono-label py-3 pr-4 text-left font-medium text-dim">Task</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Score</th>
                <th scope="col" className="mono-label py-3 pr-4 text-right font-medium text-dim">Duration</th>
                <th scope="col" className="mono-label py-3 pr-4 text-left font-medium text-dim">Mode</th>
                <th scope="col" className="mono-label py-3 text-right font-medium text-dim">When</th>
              </tr>
            </thead>
            <tbody>
              {matches.map(({ match, task }) => {
                const [pa, pb] = match.participants;
                const href =
                  match.status === "complete" || match.status === "failed"
                    ? `/matches/${match.id}`
                    : `/arena/${match.id}`;
                return (
                  <tr key={match.id} className="group border-b border-line/60 hover:bg-base">
                    <td className="py-3 pr-4">
                      <Link href={href} className="tnum font-mono text-[12px] text-dim">
                        {match.number}
                      </Link>
                    </td>
                    <td className="py-3 pr-4">
                      <Link href={href} className="flex items-center gap-2">
                        <Emblem emblem={pa.configSnapshot.emblem} accent={pa.configSnapshot.accent} size="sm" />
                        <span className={cx("text-[13px]", match.result === "A" ? "text-text" : "text-dim")}>
                          {pa.configSnapshot.name}
                        </span>
                        <span className="mono-label text-dim">vs</span>
                        <span className={cx("text-[13px]", match.result === "B" ? "text-text" : "text-dim")}>
                          {pb.configSnapshot.name}
                        </span>
                        <Emblem emblem={pb.configSnapshot.emblem} accent={pb.configSnapshot.accent} size="sm" />
                      </Link>
                    </td>
                    <td className="max-w-[22ch] truncate py-3 pr-4 text-[13px] text-dim">
                      {task?.title ?? "—"}
                    </td>
                    <td className="tnum py-3 pr-4 text-right font-mono text-[13px] text-mid">
                      {fmtScore(pa.scoreTotal)}
                      <span className="px-1 text-dim">:</span>
                      {fmtScore(pb.scoreTotal)}
                    </td>
                    <td className="tnum py-3 pr-4 text-right font-mono text-[12px] text-dim">
                      {fmtMs(match.durationMs)}
                    </td>
                    <td className="py-3 pr-4">
                      {match.status === "failed" ? <Chip tone="fail">Failed</Chip> : <ModeChip mode={match.mode} />}
                    </td>
                    <td className="mono-label py-3 text-right text-dim">{fmtRelative(match.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
