"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "motion/react";

/**
 * Live arena telemetry.
 *
 * Every figure here is measured — agent count, match count, executions that
 * actually completed, real success rate. A value that has never been measured
 * renders as an em-dash, not a zero and not a placeholder.
 *
 * The count-up runs once on first view and lands on the real number. It is a
 * reveal, not an animation loop, and reduced motion skips it entirely.
 */

export interface TelemetryItem {
  label: string;
  value: number | null;
  format?: "int" | "pct";
  tone?: "amber" | "cyan";
  note?: string;
}

export function Telemetry({ items }: { items: TelemetryItem[] }) {
  return (
    <dl className="grid grid-cols-2 divide-line border-y border-line md:grid-cols-4 md:divide-x">
      {items.map((item) => (
        <div key={item.label} className="border-b border-line px-4 py-5 md:border-b-0 md:px-6">
          <dt className="mono-label text-dim">{item.label}</dt>
          <dd className="mt-2">
            <CountUp value={item.value} format={item.format ?? "int"} tone={item.tone} />
            {item.note ? <p className="mt-1.5 text-[11px] leading-snug text-dim">{item.note}</p> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CountUp({
  value,
  format,
  tone,
}: {
  value: number | null;
  format: "int" | "pct";
  tone?: "amber" | "cyan";
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });

  // Whether a reveal will run at all is fixed for this element's lifetime, so
  // the initial progress can be decided at mount instead of synced in an effect.
  const willAnimate = !reduced && value !== null;
  const [progress, setProgress] = useState(willAnimate ? 0 : 1);

  useEffect(() => {
    if (!willAnimate || !inView) return;

    const duration = 520;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const elapsed = Math.min(1, (now - start) / duration);
      // Ease-out so it decelerates into the real value rather than snapping.
      setProgress(1 - (1 - elapsed) ** 3);
      if (elapsed < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [willAnimate, inView]);

  const shown = value === null ? null : value * progress;

  const toneClass = tone === "amber" ? "text-a" : tone === "cyan" ? "text-b" : "text-text";

  return (
    <span
      ref={ref}
      className={`tnum block font-mono text-[26px] leading-none sm:text-[30px] ${
        shown === null ? "text-dim" : toneClass
      }`}
    >
      {shown === null
        ? "—"
        : format === "pct"
          ? `${(shown * 100).toFixed(1)}%`
          : Math.round(shown).toLocaleString("en-US")}
    </span>
  );
}
