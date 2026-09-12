"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Swords } from "lucide-react";
import { Button, ButtonLink, Chip, Emblem, cx, fmtScore } from "@/components/ui/primitives";

/**
 * The shareable result.
 *
 * The card shows the same numbers the match page does, including the DEMO
 * label — a shared result that hides how it was produced would be the one place
 * the product lied, and it is the place it would matter most.
 */

interface ShareSide {
  name: string;
  emblem: string;
  accent: "amber" | "cyan" | "neutral";
  handle: string | null;
  score: number | null;
  side: "A" | "B";
}

export function ShareCard({
  matchId,
  matchNumber,
  result,
  mode,
  taskTitle,
  sides,
}: {
  matchId: string;
  matchNumber: number;
  result: string | null;
  mode: "live" | "demo";
  taskTitle: string;
  sides: ShareSide[];
}) {
  const [copied, setCopied] = useState(false);
  const winner = sides.find((s) => s.side === result) ?? null;
  const other = sides.find((s) => s.side !== result) ?? null;

  async function copyLink() {
    const url = `${window.location.origin}/matches/${matchId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the URL is in the address bar regardless.
      setCopied(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
      <div className="ticked border border-line bg-base p-8">
        <div className="flex items-center gap-2">
          <span className="mono-label text-a">AI Agent Arena</span>
          <Chip tone={mode === "live" ? "cyan" : "muted"} className="ml-auto">
            {mode}
          </Chip>
        </div>

        {winner && other ? (
          <>
            <div className="mt-7 flex items-center gap-3">
              <Emblem emblem={winner.emblem} accent={winner.accent} size="md" />
              <p className="display text-[clamp(22px,3.4vw,34px)] text-bright">{winner.name}</p>
            </div>
            <p className="mono-label mt-3 text-dim">defeated</p>
            <div className="mt-3 flex items-center gap-3">
              <Emblem emblem={other.emblem} accent={other.accent} size="sm" />
              <p className="display-tight text-xl text-mid">{other.name}</p>
            </div>

            <p className="tnum mt-7 font-mono text-[34px] leading-none text-text">
              {fmtScore(winner.score)}
              <span className="px-3 text-dim">→</span>
              <span className="text-dim">{fmtScore(other.score)}</span>
            </p>
          </>
        ) : (
          <>
            <p className="display mt-7 text-[clamp(22px,3.4vw,34px)] text-bright">
              {result === "draw" ? "Draw" : result === "double_failure" ? "No winner" : "Match complete"}
            </p>
            <p className="tnum mt-6 font-mono text-[30px] leading-none text-mid">
              {sides.map((s) => fmtScore(s.score)).join("  :  ")}
            </p>
          </>
        )}

        <div className="mt-7 border-t border-line pt-5">
          <p className="mono-label text-dim">Task</p>
          <p className="mt-1.5 text-sm text-mid">{taskTitle}</p>
        </div>

        <p className="mono-label mt-6 text-dim">Match #{matchNumber}</p>
      </div>

      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed text-dim">
          Share the result and anyone can open the full replay — every tool call, every failure, every
          assertion. Nothing about the run is hidden behind the headline.
        </p>

        <div className="flex flex-wrap gap-3">
          <Button onClick={copyLink} tone={copied ? "ghost" : "primary"}>
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied ? "Link copied" : "Copy link"}
          </Button>
          <ButtonLink href={`/matches/${matchId}#replay`}>View replay</ButtonLink>
        </div>

        <div className="mt-2 border-t border-line pt-5">
          <p className="mono-label text-dim">Challenge</p>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">
            Think you can build something that beats this? Take either agent into the arena against
            one of yours.
          </p>
          <ul className="mt-4 space-y-2">
            {sides.map((side) => (
              <li key={side.side}>
                <Link
                  href={side.handle ? `/agents/${side.handle}` : "/agents"}
                  className={cx(
                    "mono-label flex items-center gap-2 border border-line px-3 py-2 transition-colors hover:border-line-strong hover:bg-surface",
                  )}
                >
                  <Swords size={12} aria-hidden className="text-dim" />
                  Challenge {side.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
