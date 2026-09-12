"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import type { Artifact, Match, MatchResult, ScoreDimension, Side, Task } from "@/lib/arena/types";
import { AgentPanel } from "./AgentPanel";
import { EventStream } from "./EventStream";
import { Countdown } from "./Countdown";
import { ResultReveal, type RevealSide } from "./ResultReveal";
import { ArtifactViewer } from "./ArtifactViewer";
import { useMatchStream, type Speed } from "./useMatchStream";
import { Chip, LiveChip, ModeChip, Shell, cx, fmtMs } from "@/components/ui/primitives";

/**
 * The arena screen.
 *
 * Left and right are the competitors, the centre is the shared environment, the
 * bottom is the raw event stream. Everything visible derives from one SSE
 * connection.
 */

interface FinalSide {
  total: number | null;
  dimensions: ScoreDimension[];
  ratingBefore: number;
  ratingAfter: number | null;
  artifacts: Artifact[];
}

export function ArenaStage({
  match,
  task,
  autoStart,
}: {
  match: Match;
  task: Task;
  autoStart: boolean;
}) {
  const alreadyRun = match.status === "complete" || match.status === "failed";
  const [countdownDone, setCountdownDone] = useState(!autoStart || alreadyRun);
  const [started, setStarted] = useState(alreadyRun || match.status === "running");
  const [startError, setStartError] = useState<string | null>(null);
  const [final, setFinal] = useState<Record<Side, FinalSide> | null>(null);
  const [result, setResult] = useState<MatchResult>(match.result);
  const [filter, setFilter] = useState<Side | "all">("all");

  const stream = useMatchStream(match.id, started);
  const { state, backlog, speed, setSpeed, finished, status } = stream;

  // The match was server-rendered while still pending, so its environment hash
  // was null then. It is published with `match.started` — read it off the stream.
  const startedEvent = state.events.find((e) => e.type === "match.started");
  const envHash =
    match.envHash ??
    (typeof startedEvent?.data?.envHash === "string" ? startedEvent.data.envHash : null);

  // Kick the run off once the countdown has played.
  useEffect(() => {
    if (!countdownDone || started) return;
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/matches/${match.id}/start`, { method: "POST" });
        const body = (await response.json()) as { ok: boolean; error?: { message: string } };
        if (cancelled) return;
        if (!body.ok) {
          setStartError(body.error?.message ?? "The match could not be started.");
          return;
        }
        setStarted(true);
      } catch {
        if (!cancelled) setStartError("Could not reach the arena. Check the server is running.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [countdownDone, started, match.id]);

  // Once the stream has fully drained, load the graded result.
  useEffect(() => {
    if (!finished || final) return;
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/matches/${match.id}`);
        const body = (await response.json()) as {
          ok: boolean;
          data?: {
            match: Match;
            sides: {
              side: Side;
              score: { total: number; dimensions: ScoreDimension[] } | null;
              ratingBefore: number;
              ratingAfter: number | null;
              artifacts: Artifact[];
            }[];
          };
        };
        if (cancelled || !body.ok || !body.data) return;
        const next = {} as Record<Side, FinalSide>;
        for (const side of body.data.sides) {
          next[side.side] = {
            total: side.score?.total ?? null,
            dimensions: side.score?.dimensions ?? [],
            ratingBefore: side.ratingBefore,
            ratingAfter: side.ratingAfter,
            artifacts: side.artifacts,
          };
        }
        setFinal(next);
        setResult(body.data.match.result);
      } catch {
        // The reveal simply stays unavailable; the match page has the detail.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [finished, final, match.id]);

  const onCountdownComplete = useCallback(() => setCountdownDone(true), []);

  const configs = {
    A: match.participants[0].configSnapshot,
    B: match.participants[1].configSnapshot,
  };

  const phase: "pre" | "running" | "evaluating" | "complete" =
    final && result !== null
      ? "complete"
      : state.matchStatus === "evaluating" || (finished && !final)
        ? "evaluating"
        : started
          ? "running"
          : "pre";

  return (
    <>
      <AnimatePresence>
        {!countdownDone ? <Countdown onComplete={onCountdownComplete} /> : null}
      </AnimatePresence>

      {/* ── header ──────────────────────────────────────────────────────── */}
      <div className="border-b border-line bg-base">
        <Shell className="flex flex-wrap items-center gap-x-5 gap-y-3 py-4">
          <span className="display-tight text-lg text-text">Match #{match.number}</span>

          {phase === "running" ? (
            <LiveChip />
          ) : phase === "evaluating" ? (
            <Chip tone="amber">Evaluating</Chip>
          ) : phase === "complete" ? (
            <Chip tone="muted">Complete</Chip>
          ) : (
            <Chip tone="muted">Ready</Chip>
          )}

          <ModeChip mode={match.mode} />

          <Link
            href={`/tasks/${task.slug}`}
            className="mono-label min-w-0 truncate text-dim transition-colors hover:text-a"
          >
            {task.title}
          </Link>

          <div className="ml-auto flex items-center gap-4">
            <span className="flex items-baseline gap-2" title="Wall-clock time the run itself took, independent of playback speed.">
              <span className="mono-label text-dim">Run</span>
              <span className="tnum font-mono text-sm text-mid">{fmtMs(state.elapsedMs)}</span>
            </span>

            {phase === "running" || backlog > 0 ? (
              <div className="flex items-center gap-1">
                <span className="mono-label mr-1 text-dim">Speed</span>
                {([1, 2, 4, 0] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setSpeed(option as Speed)}
                    aria-pressed={speed === option}
                    className={cx(
                      "mono-label border px-2 py-1 transition-colors",
                      speed === option
                        ? "border-a-line bg-a-deep text-a"
                        : "border-line text-dim hover:text-mid",
                    )}
                  >
                    {option === 0 ? "Max" : `${option}x`}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </Shell>

        {backlog > 0 ? (
          <Shell className="pb-3">
            <p className="mono-label text-dim">
              <span className="text-a">{backlog}</span> event{backlog === 1 ? "" : "s"} buffered ahead of
              playback — the run is real-time, the rendering is paced so it can be read.
            </p>
          </Shell>
        ) : null}
      </div>

      {startError ? (
        <Shell className="py-6">
          <div className="border border-fail/40 bg-fail-deep px-5 py-4">
            <p className="mono-label text-fail">Could not start</p>
            <p className="mt-2 text-sm text-mid">{startError}</p>
            <Link href="/arena" className="mono-label mt-3 inline-block text-a">
              Back to the lobby
            </Link>
          </div>
        </Shell>
      ) : null}

      {stream.error ? (
        <Shell className="pt-6">
          <div className="border border-fail/40 bg-fail-deep px-5 py-3">
            <p className="text-sm text-mid">{stream.error}</p>
          </div>
        </Shell>
      ) : null}

      {/* ── stage ───────────────────────────────────────────────────────── */}
      <Shell className="py-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
          <AgentPanel config={configs.A} side="A" state={state.sides.A} />

          <div className="order-first flex min-h-[320px] flex-col gap-4 lg:order-none">
            <CentreStage
              phase={phase}
              task={task}
              result={result}
              final={final}
              match={match}
              envHash={envHash}
              status={status}
            />
          </div>

          <AgentPanel config={configs.B} side="B" state={state.sides.B} align="right" />
        </div>

        <div className="mt-4">
          <EventStream events={state.events} height={280} filter={filter} onFilterChange={setFilter} />
        </div>

        {phase === "complete" && final ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {(["A", "B"] as const).map((side) => (
              <div key={side}>
                <p className="mono-label mb-2 text-dim">
                  {configs[side].name} — artifacts
                </p>
                <ArtifactViewer
                  artifacts={final[side].artifacts}
                  accent={side === "A" ? "amber" : "cyan"}
                  height={320}
                />
              </div>
            ))}
          </div>
        ) : null}
      </Shell>
    </>
  );
}

function CentreStage({
  phase,
  task,
  result,
  final,
  match,
  envHash,
  status,
}: {
  phase: "pre" | "running" | "evaluating" | "complete";
  task: Task;
  result: MatchResult;
  final: Record<Side, FinalSide> | null;
  match: Match;
  envHash: string | null;
  status: string;
}) {
  if (phase === "complete" && final) {
    const sides: [RevealSide, RevealSide] = [
      {
        config: match.participants[0].configSnapshot,
        side: "A",
        total: final.A.total,
        dimensions: final.A.dimensions,
        ratingBefore: final.A.ratingBefore,
        ratingAfter: final.A.ratingAfter,
      },
      {
        config: match.participants[1].configSnapshot,
        side: "B",
        total: final.B.total,
        dimensions: final.B.dimensions,
        ratingBefore: final.B.ratingBefore,
        ratingAfter: final.B.ratingAfter,
      },
    ];
    return (
      <ResultReveal
        result={result}
        sides={sides}
        matchId={match.id}
        matchNumber={match.number}
        taskTitle={task.title}
        mode={match.mode}
      />
    );
  }

  return (
    <div className="flex h-full flex-col border border-line bg-base">
      <div className="border-b border-line px-4 py-2.5">
        <span className="mono-label text-dim">Shared environment</span>
      </div>

      <div className="flex flex-1 flex-col justify-center px-6 py-8 text-center">
        {phase === "evaluating" ? (
          <>
            <p className="mono-label text-a">Evaluating</p>
            <p className="display mt-4 text-3xl text-text">Running the graders</p>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-dim">
              The task&rsquo;s assertions are executing against each agent&rsquo;s real workspace.
            </p>
          </>
        ) : phase === "running" ? (
          <>
            <p className="mono-label text-dim">In progress</p>
            <p className="display mt-4 text-[clamp(22px,3vw,34px)] text-text">{task.title}</p>
            <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-dim">{task.brief}</p>
            <dl className="mx-auto mt-8 grid w-full max-w-sm grid-cols-3 gap-px bg-line">
              <Fact label="Steps" value={String(task.limits.stepLimit)} />
              <Fact label="Time" value={`${Math.round(task.limits.timeLimitMs / 1000)}s`} />
              <Fact label="Env hash" value={envHash?.slice(0, 8) ?? "—"} />
            </dl>
          </>
        ) : (
          <>
            <p className="mono-label text-dim">{status === "idle" ? "Standing by" : "Connecting"}</p>
            <p className="display mt-4 text-[clamp(22px,3vw,34px)] text-text">{task.title}</p>
            <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-dim">{task.brief}</p>
          </>
        )}
      </div>

      <div className="border-t border-line px-4 py-3">
        <p className="mono-label text-dim">
          Both agents received an identical environment
          {envHash ? (
            <>
              {" — hash "}
              <span className="text-mid">{envHash.slice(0, 12)}</span>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-void px-3 py-3">
      <dt className="mono-label text-dim">{label}</dt>
      <dd className="tnum mt-1 font-mono text-sm text-mid">{value}</dd>
    </div>
  );
}
