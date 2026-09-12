import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArtifactViewer } from "@/components/arena/ArtifactViewer";
import { ReplayPlayer } from "@/components/arena/ReplayPlayer";
import { DimensionTable } from "@/components/arena/ResultReveal";
import { ShareCard } from "@/components/matches/ShareCard";
import { VotePanel } from "@/components/matches/VotePanel";
import {
  Chip,
  Emblem,
  ModeChip,
  SectionRule,
  Shell,
  Stat,
  cx,
  fmtMs,
  fmtNumber,
  fmtPct,
  fmtScore,
  fmtUsd,
} from "@/components/ui/primitives";
import { getMatchDetail, getReplay } from "@/lib/server/queries";
import { getVoteStore } from "@/lib/store";
import { viewerId } from "@/lib/server/identity";
import type { AgentSideDetail } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const detail = await getMatchDetail(id);
  if (!detail) return { title: "Match not found" };
  const [a, b] = detail.sides;
  return {
    title: `Match #${detail.match.number} — ${a.configSnapshot.name} vs ${b.configSnapshot.name}`,
    description: `${detail.task?.title ?? "A task"} — ${fmtScore(a.score?.total)} to ${fmtScore(b.score?.total)}.`,
  };
}

export default async function MatchDetailPage({ params }: Props) {
  const { id } = await params;
  const [detail, replay, viewer] = await Promise.all([getMatchDetail(id), getReplay(id), viewerId()]);
  if (!detail) notFound();

  const votes = await (await getVoteStore()).getVotes(id, viewer ?? undefined);

  const { match, task, sides, winner, loser, whyWon } = detail;
  const [a, b] = sides;

  if (match.status === "pending" || match.status === "running") {
    return (
      <Shell className="py-16 text-center">
        <p className="mono-label text-dim">Match #{match.number}</p>
        <h1 className="display mt-4 text-4xl text-text">This match has not finished.</h1>
        <p className="mx-auto mt-4 max-w-md text-sm text-dim">
          Results appear here once both agents have run and the graders have scored them.
        </p>
        <Link href={`/arena/${match.id}`} className="mono-label mt-6 inline-block text-a">
          Watch it in the arena
        </Link>
      </Shell>
    );
  }

  return (
    <Shell className="py-10">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="mono-label text-dim">Match #{match.number}</span>
        <ModeChip mode={match.mode} />
        {match.status === "failed" ? <Chip tone="fail">Failed</Chip> : null}
        {!match.rated ? <Chip tone="muted">Unrated</Chip> : null}
      </div>

      <h1 className="display mt-6 text-[clamp(26px,4.5vw,46px)] text-bright">
        {a.configSnapshot.name}
        <span className="px-3 text-dim">vs</span>
        {b.configSnapshot.name}
      </h1>
      {task ? (
        <Link
          href={`/tasks/${task.slug}`}
          className="mono-label mt-3 inline-block text-dim transition-colors hover:text-a"
        >
          {task.title}
        </Link>
      ) : null}

      {match.mode === "demo" ? (
        <p className="mt-4 border border-line bg-base px-4 py-3 text-[13px] leading-relaxed text-dim">
          <span className="text-mid">Scripted policy · real execution.</span> No model provider was
          configured, so a deterministic policy chose each action. The tools, filesystem, code
          execution and graders below are the real ones, and the scores were genuinely earned by the
          artifacts these agents actually produced — but the decisions were pre-authored, so this
          match says nothing about model capability.
        </p>
      ) : null}

      {/* result */}
      <div className="mt-8 grid gap-px bg-line lg:grid-cols-2">
        {sides.map((side) => (
          <SideSummary key={side.side} side={side} won={winner?.side === side.side} result={match.result} />
        ))}
      </div>

      {/* why the winner won */}
      {winner && loser ? (
        <div className="mt-10">
          <SectionRule label="Why the winner won" />
          {whyWon.length === 0 ? (
            <p className="mt-6 text-sm leading-relaxed text-dim">
              Nothing separated these two by a material margin on any weighted dimension. The result
              came down to the score total alone.
            </p>
          ) : (
            <>
              <p className="mt-6 text-sm text-mid">
                <span className="text-text">{winner.configSnapshot.name}</span> beat{" "}
                <span className="text-text">{loser.configSnapshot.name}</span> because:
              </p>
              <ul className="mt-4 divide-y divide-line border-y border-line">
                {whyWon.map((factor) => (
                  <li key={factor.key} className="flex flex-wrap items-baseline gap-x-5 gap-y-1 py-3">
                    <span
                      className={cx(
                        "tnum w-20 shrink-0 font-mono text-sm",
                        factor.delta > 0 ? "text-ok" : "text-fail",
                      )}
                    >
                      {factor.display}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-mid">{factor.label}</span>
                    <span className="tnum font-mono text-xs text-dim">{factor.detail}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-dim">
                Every figure here is the difference between two stored measurements. The generator
                can subtract; it cannot invent.
              </p>
            </>
          )}
        </div>
      ) : null}

      {/* score breakdown */}
      {a.score && b.score ? (
        <div className="mt-12">
          <SectionRule
            label="Score breakdown"
            right={
              task?.evaluation.weightsOverridden ? (
                <Chip tone="muted" title="This task overrides its category's default weights.">
                  Custom weights
                </Chip>
              ) : null
            }
          />
          <div className="mt-6">
            <DimensionTable
              sides={[
                {
                  config: a.configSnapshot,
                  side: "A",
                  total: a.score.total,
                  dimensions: a.score.dimensions,
                  ratingBefore: a.ratingBefore,
                  ratingAfter: a.ratingAfter,
                },
                {
                  config: b.configSnapshot,
                  side: "B",
                  total: b.score.total,
                  dimensions: b.score.dimensions,
                  ratingBefore: b.ratingBefore,
                  ratingAfter: b.ratingAfter,
                },
              ]}
            />
          </div>
        </div>
      ) : null}

      {/* tests */}
      {a.evaluation && a.evaluation.tests.length > 0 ? (
        <div className="mt-12">
          <SectionRule label="Assertions" />
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {sides.map((side) => (
              <div key={side.side}>
                <p className="mono-label mb-3 text-dim">{side.configSnapshot.name}</p>
                <ul className="divide-y divide-line border-y border-line">
                  {(side.evaluation?.tests ?? []).map((test) => (
                    <li key={test.id} className="flex items-start gap-3 py-2.5">
                      <span
                        className={cx(
                          "mono-label mt-0.5 w-10 shrink-0",
                          test.passed ? "text-ok" : "text-fail",
                        )}
                      >
                        {test.passed ? "PASS" : "FAIL"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-mid">{test.name}</span>
                        {!test.passed ? (
                          <span className="mt-0.5 block font-mono text-[11px] text-dim">{test.message}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* rubric */}
      {a.evaluation && a.evaluation.rubric.length > 0 ? (
        <div className="mt-12">
          <SectionRule label="Rubric checks" />
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {sides.map((side) => (
              <div key={side.side}>
                <p className="mono-label mb-3 text-dim">{side.configSnapshot.name}</p>
                <ul className="divide-y divide-line border-y border-line">
                  {(side.evaluation?.rubric ?? []).map((check) => (
                    <li key={check.id} className="flex items-start gap-3 py-2.5">
                      <span
                        className={cx(
                          "tnum mono-label mt-0.5 w-10 shrink-0",
                          check.passed ? "text-ok" : check.score > 0 ? "text-warn" : "text-fail",
                        )}
                      >
                        {(check.score * 100).toFixed(0)}%
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-mid">{check.name}</span>
                        <span className="mt-0.5 block font-mono text-[11px] text-dim">{check.message}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* unavailable evaluators */}
      {a.evaluation && a.evaluation.unavailable.length > 0 ? (
        <div className="mt-12">
          <SectionRule label="Not measured" />
          <ul className="mt-6 divide-y divide-line border-y border-line">
            {a.evaluation.unavailable.map((item) => (
              <li key={item.dimension} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                <span className="mono-label w-48 shrink-0 text-dim">{item.dimension}</span>
                <span className="min-w-0 flex-1 text-[13px] text-mid">{item.reason}</span>
                <Chip tone="muted">Weight redistributed</Chip>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* tool usage */}
      <div className="mt-12">
        <SectionRule label="Tool usage" />
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {sides.map((side) => (
            <ToolTable key={side.side} side={side} />
          ))}
        </div>
      </div>

      {/* artifacts */}
      <div className="mt-12">
        <SectionRule label="Artifacts" />
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {sides.map((side) => (
            <div key={side.side}>
              <p className="mono-label mb-3 text-dim">{side.configSnapshot.name}</p>
              <ArtifactViewer
                artifacts={side.artifacts}
                accent={side.side === "A" ? "amber" : "cyan"}
                height={380}
              />
            </div>
          ))}
        </div>
      </div>

      {/* replay */}
      {replay ? (
        <div className="mt-12 scroll-mt-20" id="replay">
          <SectionRule
            label="Replay"
            right={<span className="mono-label text-dim">{replay.events.length} events</span>}
          />
          <div className="mt-6">
            <ReplayPlayer replay={replay} />
          </div>
        </div>
      ) : null}

      <VotePanel
        matchId={match.id}
        names={{ A: a.configSnapshot.name, B: b.configSnapshot.name }}
        initial={votes}
        verdict={match.result === "A" || match.result === "B" ? match.result : match.result === "draw" ? "draw" : null}
      />

      {/* share */}
      <div className="mt-12">
        <SectionRule label="Share" />
        <div className="mt-6">
          <ShareCard
            matchId={match.id}
            matchNumber={match.number}
            result={match.result}
            mode={match.mode}
            taskTitle={task?.title ?? "a task"}
            sides={sides.map((s) => ({
              name: s.configSnapshot.name,
              emblem: s.configSnapshot.emblem,
              accent: s.configSnapshot.accent,
              handle: s.agent?.config.handle ?? null,
              score: s.score?.total ?? null,
              side: s.side,
            }))}
          />
        </div>
      </div>

      {/* provenance */}
      <div className="mt-12 border-t border-line pt-6">
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Environment hash" value={match.envHash?.slice(0, 16) ?? null} hint="not recorded" />
          <Stat label="Seed" value={match.seed} />
          <Stat label="Duration" value={fmtMs(match.durationMs)} />
          <Stat label="Season" value={detail.season?.name ?? null} />
        </dl>
        <p className="mt-5 text-[11px] leading-relaxed text-dim">
          Both workspaces were built from the same seed and hashed before either agent took a step;
          the match would have been refused if they differed. Each participant is pinned to the exact
          agent configuration it ran, so editing an agent later never rewrites this result.
        </p>
      </div>
    </Shell>
  );
}

function SideSummary({
  side,
  won,
  result,
}: {
  side: AgentSideDetail;
  won: boolean;
  result: string | null;
}) {
  const config = side.configSnapshot;
  const delta = side.ratingAfter === null ? null : side.ratingAfter - side.ratingBefore;
  const metrics = side.evaluation?.metrics ?? [];
  const value = (key: string) => metrics.find((m) => m.key === key)?.value ?? null;

  return (
    <div className={cx("bg-void p-6", won && "bg-base")}>
      <div className="flex items-center gap-3">
        <Emblem emblem={config.emblem} accent={config.accent} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="mono-label text-dim">Agent {side.side}</span>
            {won ? <Chip tone="amber">Winner</Chip> : null}
            {result === "draw" ? <Chip tone="muted">Draw</Chip> : null}
          </div>
          {side.agent ? (
            <Link href={`/agents/${side.agent.config.handle}`} className="block">
              <h2 className="display-tight mt-1 truncate text-xl text-text transition-colors hover:text-a">
                {config.name}
              </h2>
            </Link>
          ) : (
            <h2 className="display-tight mt-1 truncate text-xl text-text">{config.name}</h2>
          )}
          <p className="mono-label mt-1 text-dim">{config.model.label}</p>
        </div>
        <div className="text-right">
          <p className={cx("tnum font-mono text-[40px] leading-none", won ? "text-a" : "text-mid")}>
            {fmtScore(side.score?.total)}
          </p>
          <p className="mono-label mt-2 text-dim">
            Elo {side.ratingBefore}
            {delta !== null ? (
              <span className={cx("ml-1.5", delta > 0 ? "text-ok" : delta < 0 ? "text-fail" : "")}>
                {delta > 0 ? "+" : ""}
                {delta}
              </span>
            ) : null}
          </p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="Tests" value={fmtPct(value("tests.passRate"))} hint="no assertions on this task" />
        <Stat label="Steps" value={fmtNumber(side.execution?.steps)} />
        <Stat label="Tools" value={fmtNumber(value("tools.called"))} />
        <Stat
          label="Resilience"
          value={fmtPct(value("resilience.score"))}
          hint="no tools were called"
        />
        <Stat label="Efficiency" value={fmtPct(value("efficiency.score"))} />
        <Stat label="Duration" value={fmtMs(side.execution?.durationMs)} />
        <Stat label="Cost" value={fmtUsd(side.execution?.usage.costUsd)} hint="not reported by the provider" />
        <Stat label="Outcome" value={side.execution?.outcome ?? null} />
      </dl>

      {side.execution?.finalMessage ? (
        <p className="mt-6 border-t border-line pt-4 text-[13px] leading-relaxed text-dim">
          {side.execution.finalMessage}
        </p>
      ) : null}
      {side.execution?.error ? (
        <p className="mt-4 border border-fail/40 bg-fail-deep px-3 py-2 text-[12px] text-fail">
          {side.execution.error}
        </p>
      ) : null}
    </div>
  );
}

function ToolTable({ side }: { side: AgentSideDetail }) {
  const byTool = new Map<string, { calls: number; failed: number; totalMs: number }>();
  for (const call of side.toolCalls) {
    const row = byTool.get(call.tool) ?? { calls: 0, failed: 0, totalMs: 0 };
    row.calls += 1;
    if (call.status === "error") row.failed += 1;
    row.totalMs += call.durationMs;
    byTool.set(call.tool, row);
  }
  const rows = [...byTool.entries()].sort((x, y) => y[1].calls - x[1].calls);

  return (
    <div>
      <p className="mono-label mb-3 text-dim">{side.configSnapshot.name}</p>
      {rows.length === 0 ? (
        <p className="border border-line px-4 py-6 text-sm text-dim">No tools were called.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="mono-label py-2 text-left font-medium text-dim">Tool</th>
              <th scope="col" className="mono-label py-2 text-right font-medium text-dim">Calls</th>
              <th scope="col" className="mono-label py-2 text-right font-medium text-dim">Failed</th>
              <th scope="col" className="mono-label py-2 text-right font-medium text-dim">Mean</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([tool, row]) => (
              <tr key={tool} className="border-b border-line/60">
                <td className="py-2.5 font-mono text-[12px] text-mid">{tool}</td>
                <td className="tnum py-2.5 text-right font-mono text-[12px] text-text">{row.calls}</td>
                <td
                  className={cx(
                    "tnum py-2.5 text-right font-mono text-[12px]",
                    row.failed > 0 ? "text-fail" : "text-dim",
                  )}
                >
                  {row.failed || "—"}
                </td>
                <td className="tnum py-2.5 text-right font-mono text-[12px] text-dim">
                  {fmtMs(row.totalMs / row.calls)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
