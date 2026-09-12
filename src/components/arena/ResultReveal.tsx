"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { AgentConfig, MatchResult, ScoreDimension } from "@/lib/arena/types";
import { ButtonLink, Chip, Emblem, Meter, cx, fmtPct } from "@/components/ui/primitives";

/**
 * The result.
 *
 * Staged: the outcome, then the totals, then the dimensions that produced them.
 * Every figure is read from the stored score — the reveal controls when a
 * number appears, never what it is.
 */

export interface RevealSide {
  config: AgentConfig;
  side: "A" | "B";
  total: number | null;
  dimensions: ScoreDimension[];
  ratingBefore: number;
  ratingAfter: number | null;
}

export function ResultReveal({
  result,
  sides,
  matchId,
  matchNumber,
  taskTitle,
  mode,
}: {
  result: MatchResult;
  sides: [RevealSide, RevealSide];
  matchId: string;
  matchNumber: number;
  taskTitle: string;
  mode: "live" | "demo";
}) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(reduced ? 3 : 0);

  useEffect(() => {
    if (reduced || phase >= 3) return;
    const timer = setTimeout(() => setPhase((p) => p + 1), phase === 0 ? 900 : 700);
    return () => clearTimeout(timer);
  }, [phase, reduced]);

  const winner = result === "A" ? sides[0] : result === "B" ? sides[1] : null;
  const headline =
    result === "draw"
      ? "Draw"
      : result === "double_failure"
        ? "No winner"
        : (winner?.config.name ?? "Match complete");

  return (
    <div className="border border-line bg-base">
      <div className="border-b border-line px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="mono-label text-dim">Match #{matchNumber}</span>
          <Chip tone={mode === "live" ? "cyan" : "muted"}>{mode}</Chip>
          <span className="mono-label ml-auto truncate text-dim">{taskTitle}</span>
        </div>
      </div>

      {/* winner */}
      <motion.div
        className="px-6 py-10 text-center"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <p className="mono-label text-dim">
          {result === "draw"
            ? "Result"
            : result === "double_failure"
              ? "Result"
              : "Winner"}
        </p>
        <p className="display mt-3 text-[clamp(34px,6vw,64px)] text-bright">{headline}</p>
        {result === "draw" ? (
          <p className="mx-auto mt-3 max-w-md text-sm text-dim">
            Scores within half a point. A result decided by a rounding artefact is not a result.
          </p>
        ) : result === "double_failure" ? (
          <p className="mx-auto mt-3 max-w-md text-sm text-dim">
            Both agents failed every assertion. Two agents failing badly does not crown one of them.
          </p>
        ) : null}
      </motion.div>

      {/* scores */}
      {phase >= 1 ? (
        <motion.div
          className="grid grid-cols-2 divide-x divide-line border-y border-line"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35 }}
        >
          {sides.map((side) => {
            const won = result === side.side;
            const delta = side.ratingAfter === null ? null : side.ratingAfter - side.ratingBefore;
            return (
              <div key={side.side} className={cx("px-6 py-6", won && "bg-surface")}>
                <div className="flex items-center gap-3">
                  <Emblem emblem={side.config.emblem} accent={side.config.accent} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{side.config.name}</span>
                  {won ? <Chip tone="amber">Win</Chip> : null}
                </div>
                <p
                  className={cx(
                    "tnum mt-4 font-mono text-[44px] leading-none",
                    side.total === null ? "text-dim" : won ? "text-a" : "text-mid",
                  )}
                >
                  {side.total === null ? "—" : side.total.toFixed(1)}
                </p>
                <p className="mono-label mt-3 text-dim">
                  Elo {side.ratingBefore}
                  {delta !== null ? (
                    <span className={cx("ml-2", delta > 0 ? "text-ok" : delta < 0 ? "text-fail" : "text-dim")}>
                      {delta > 0 ? "+" : ""}
                      {delta}
                    </span>
                  ) : null}
                </p>
              </div>
            );
          })}
        </motion.div>
      ) : null}

      {/* dimensions */}
      {phase >= 2 ? (
        <motion.div
          className="px-6 py-6"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35 }}
        >
          <p className="mono-label mb-4 text-dim">Score breakdown</p>
          <DimensionTable sides={sides} />
        </motion.div>
      ) : null}

      {phase >= 3 ? (
        <motion.div
          className="flex flex-wrap gap-3 border-t border-line px-6 py-5"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          <ButtonLink href={`/matches/${matchId}`} tone="primary">
            Full breakdown
          </ButtonLink>
          <ButtonLink href={`/matches/${matchId}#replay`}>Watch replay</ButtonLink>
          <Link
            href="/arena"
            className="mono-label ml-auto self-center text-dim transition-colors hover:text-a"
          >
            Run another match
          </Link>
        </motion.div>
      ) : null}
    </div>
  );
}

export function DimensionTable({ sides }: { sides: [RevealSide, RevealSide] }) {
  const keys = Array.from(
    new Set([...sides[0].dimensions.map((d) => d.key), ...sides[1].dimensions.map((d) => d.key)]),
  );

  if (keys.length === 0) {
    return <p className="text-sm text-dim">No score dimensions were recorded for this match.</p>;
  }

  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Score dimensions for both agents</caption>
      <thead>
        <tr className="border-b border-line">
          <th scope="col" className="mono-label py-2 text-left font-medium text-dim">
            Dimension
          </th>
          <th scope="col" className="mono-label py-2 text-left font-medium text-a">
            {sides[0].config.name}
          </th>
          <th scope="col" className="mono-label py-2 text-left font-medium text-b">
            {sides[1].config.name}
          </th>
          <th scope="col" className="mono-label py-2 text-right font-medium text-dim">
            Weight
          </th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => {
          const a = sides[0].dimensions.find((d) => d.key === key);
          const b = sides[1].dimensions.find((d) => d.key === key);
          const label = a?.label ?? b?.label ?? key;
          const weight = a?.weight ?? b?.weight ?? 0;
          return (
            <tr key={key} className="border-b border-line/60 align-middle">
              <th scope="row" className="w-[26%] py-3 pr-4 text-left text-[13px] font-normal text-mid">
                {label}
              </th>
              <td className="w-[27%] py-3 pr-4">
                <DimensionCell dimension={a} tone="amber" />
              </td>
              <td className="w-[27%] py-3 pr-4">
                <DimensionCell dimension={b} tone="cyan" />
              </td>
              <td className="tnum py-3 text-right font-mono text-[11px] text-dim">
                {(weight * 100).toFixed(0)}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DimensionCell({
  dimension,
  tone,
}: {
  dimension: ScoreDimension | undefined;
  tone: "amber" | "cyan";
}) {
  if (!dimension) return <span className="font-mono text-xs text-dim">—</span>;

  if (!dimension.available) {
    return (
      <div className="flex flex-col gap-1">
        <span className="mono-label text-dim" title={dimension.reason}>
          Not measured
        </span>
        <Meter value={null} unavailable={dimension.reason} />
        <span className="text-[10px] leading-tight text-dim">
          {dimension.reason ? `${dimension.reason} — weight redistributed` : "weight redistributed"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="tnum font-mono text-xs text-text">{fmtPct(dimension.normalised, 0)}</span>
      <Meter value={dimension.normalised} tone={tone} />
    </div>
  );
}
