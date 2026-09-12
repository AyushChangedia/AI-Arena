"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button, cx } from "@/components/ui/primitives";
import { BRIEF_MAX, BRIEF_MIN } from "@/lib/tasks/brief";

/**
 * Type what you want built, and send two agents at it.
 *
 * The task library exists because hand-written assertions can assert
 * correctness. A brief typed here cannot be graded that way, and the arena says
 * so rather than pretending otherwise — but "watch two agents attempt *my*
 * thing" is the reason most people open this at all, so it belongs on the front
 * page rather than buried behind a picker.
 */

const EXAMPLES = [
  "Build me a coffee shop landing page for a roastery called Ember, with a menu and opening hours",
  "Write a pricing page for a small photography studio with three tiers",
  "Build a JavaScript function that parses a CSV of invoices and totals them by month",
];

export function BriefBox() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [pending, setPending] = useState(false);

  const trimmed = brief.trim();
  const ready = trimmed.length >= BRIEF_MIN;

  function send() {
    if (!ready || pending) return;
    setPending(true);
    // Handed to the arena rather than run from here: the agents, their limits
    // and the fairness checks all live there, and the brief is only half the
    // match.
    router.push(`/arena?brief=${encodeURIComponent(trimmed)}`);
  }

  return (
    <div className="border border-line bg-base">
      <div className="border-b border-line px-4 py-2.5">
        <span className="mono-label text-dim">Or set them your own task</span>
      </div>

      <div className="p-4">
        <label htmlFor="landing-brief" className="sr-only">
          What should the agents build?
        </label>
        <textarea
          id="landing-brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value.slice(0, BRIEF_MAX))}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline, as in any editor.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
          placeholder="Build me a coffee shop landing page…"
          className="w-full resize-y border border-line bg-void px-3 py-2.5 text-[15px] leading-relaxed text-text outline-none placeholder:text-dim focus:border-line-strong"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button tone="primary" onClick={send} disabled={!ready || pending} className="flex-1">
            {pending ? "Setting up…" : "Send two agents at it"}
            {!pending ? <ArrowRight size={13} aria-hidden /> : null}
          </Button>
          <span className="tnum font-mono text-[11px] text-dim">
            {trimmed.length}/{BRIEF_MAX}
          </span>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <p className="mono-label text-dim">Try</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setBrief(example)}
                className={cx(
                  "text-left text-[13px] leading-relaxed text-dim transition-colors",
                  "hover:text-mid",
                )}
              >
                “{example}”
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
