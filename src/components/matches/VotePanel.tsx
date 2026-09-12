"use client";

import { useState } from "react";
import { Button, SectionRule, cx } from "@/components/ui/primitives";

type Side = "A" | "B";
type Tally = { A: number; B: number; mine: Side | null };

/**
 * Human preference, kept next to the graded result rather than folded into it.
 *
 * The score is a measurement; this is an opinion. Showing them side by side is
 * the point — when the crowd picks the agent the assertions did not, that gap
 * says something about the task or the rubric, and averaging the two together
 * would hide exactly the signal worth having.
 */
export function VotePanel({
  matchId,
  names,
  initial,
  verdict,
}: {
  matchId: string;
  names: Record<Side, string>;
  initial: Tally;
  /** What the graders decided, so agreement or disagreement is visible. */
  verdict: Side | "draw" | null;
}) {
  const [tally, setTally] = useState<Tally>(initial);
  const [pending, setPending] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = tally.A + tally.B;

  async function vote(side: Side) {
    if (pending) return;
    setPending(side);
    setError(null);
    try {
      const response = await fetch(`/api/matches/${matchId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ side }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        data?: Tally;
        error?: { message: string };
      };
      if (!body.ok || !body.data) {
        setError(body.error?.message ?? "Your vote could not be recorded.");
        return;
      }
      setTally(body.data);
    } catch {
      setError("Could not reach the arena.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mt-14">
      <SectionRule
        label="Which one would you rather have shipped this?"
        right={
          <span className="mono-label text-dim">
            {total === 0 ? "No votes yet" : `${total} ${total === 1 ? "vote" : "votes"}`}
          </span>
        }
      />

      <div className="mt-6 grid gap-px bg-line sm:grid-cols-2">
        {(["A", "B"] as const).map((side) => {
          const count = tally[side];
          const share = total === 0 ? 0 : Math.round((count / total) * 100);
          const mine = tally.mine === side;
          return (
            <div key={side} className="bg-void p-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className={cx("mono-label", side === "A" ? "text-a" : "text-b")}>
                  Agent {side}
                </span>
                <span className="tnum font-mono text-sm text-mid">
                  {total === 0 ? "—" : `${share}%`}
                </span>
              </div>
              <p className="display-tight mt-1 truncate text-base text-text">{names[side]}</p>

              {/* The bar is the tally, drawn to scale. It is zero-width until
                  somebody actually votes — never a placeholder value. */}
              <div className="mt-3 h-1 w-full bg-line">
                <div
                  className={cx("h-full transition-[width] duration-500", side === "A" ? "bg-a" : "bg-b")}
                  style={{ width: `${share}%` }}
                />
              </div>

              <Button
                onClick={() => vote(side)}
                disabled={pending !== null}
                tone={mine ? "primary" : undefined}
                className="mt-4 w-full"
                aria-pressed={mine}
              >
                {pending === side ? "Recording…" : mine ? "Your pick" : `Vote ${names[side]}`}
              </Button>
            </div>
          );
        })}
      </div>

      {error ? (
        <p className="mt-3 border border-fail/40 bg-fail-deep px-4 py-3 text-[13px] text-fail">{error}</p>
      ) : null}

      <p className="mt-4 text-[13px] leading-relaxed text-dim">
        Preference votes are recorded separately and carry{" "}
        <span className="text-mid">no weight in the score</span> — that number is a measurement of
        what the agents did, and opinion does not belong inside it.
        {total > 0 && verdict && verdict !== "draw" ? (
          <>
            {" "}
            The graders picked <span className="text-mid">{names[verdict]}</span>
            {tally[verdict] * 2 > total ? ", and so did most voters." : ", and most voters disagreed."}
          </>
        ) : null}
      </p>
    </section>
  );
}
