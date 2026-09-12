"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

/**
 * The arena waking up.
 *
 * A single staged reveal that runs once: the field is drawn, two agent nodes
 * resolve, the environment connects, and the system reports ready. Then it
 * stops. There is no ambient loop and no particle system — the motion exists to
 * explain the topology (two agents, one environment, one task) and then gets
 * out of the way.
 *
 * With `prefers-reduced-motion` the whole sequence collapses to its end state
 * immediately.
 */

const BOOT_LINES = [
  "ARENA SYSTEM ONLINE",
  "TASK VERIFIED",
  "ENVIRONMENT SYNCED",
  "AGENTS LOCKED",
  "MATCH READY",
] as const;

export function Ignition() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const [stage, setStage] = useState(reduced ? BOOT_LINES.length : 0);

  useEffect(() => {
    if (reduced || !inView) return;
    if (stage >= BOOT_LINES.length) return;
    const timer = setTimeout(() => setStage((s) => s + 1), stage === 0 ? 260 : 420);
    return () => clearTimeout(timer);
  }, [stage, reduced, inView]);

  const ready = stage >= BOOT_LINES.length;

  return (
    <div ref={ref} className="relative">
      <ArenaField active={inView || Boolean(reduced)} ready={ready} reduced={Boolean(reduced)} />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-3">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4">
          {BOOT_LINES.map((line, index) => {
            const shown = index < stage;
            const isLast = index === BOOT_LINES.length - 1;
            return (
              <span
                key={line}
                className={[
                  "mono-label transition-opacity duration-300",
                  shown ? "opacity-100" : "opacity-0",
                  isLast && shown ? "text-a" : "text-dim",
                ].join(" ")}
              >
                {shown ? line : line}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The topology, drawn to scale: agent A and agent B, each wired to the same
 * environment, working the same task. This is the product's whole thesis in one
 * diagram, which is why it is the first thing that moves.
 */
function ArenaField({ active, ready, reduced }: { active: boolean; ready: boolean; reduced: boolean }) {
  const t = useMemo(
    () => ({
      draw: reduced ? 0 : 0.9,
      node: reduced ? 0 : 0.5,
    }),
    [reduced],
  );

  return (
    <svg
      viewBox="0 0 900 320"
      className="h-[240px] w-full sm:h-[300px]"
      role="img"
      aria-label="Two agents connected to one shared environment running one task"
    >
      <defs>
        <linearGradient id="wire-a" x1="0" x2="1">
          <stop offset="0%" stopColor="#e8a33d" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#e8a33d" stopOpacity="0.65" />
        </linearGradient>
        <linearGradient id="wire-b" x1="1" x2="0">
          <stop offset="0%" stopColor="#4ecdc4" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#4ecdc4" stopOpacity="0.65" />
        </linearGradient>
      </defs>

      {/* measurement grid */}
      <g stroke="#1d232a" strokeWidth="1">
        {Array.from({ length: 15 }, (_, i) => (
          <line key={`v${i}`} x1={i * 64} y1="0" x2={i * 64} y2="320" opacity="0.5" />
        ))}
        {Array.from({ length: 6 }, (_, i) => (
          <line key={`h${i}`} x1="0" y1={i * 64} x2="900" y2={i * 64} opacity="0.5" />
        ))}
      </g>

      {/* connections drawn before the nodes settle */}
      <motion.path
        d="M 150 160 C 260 160, 300 160, 400 160"
        fill="none"
        stroke="url(#wire-a)"
        strokeWidth="1.5"
        initial={{ pathLength: 0 }}
        animate={active ? { pathLength: 1 } : { pathLength: 0 }}
        transition={{ duration: t.draw, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.15 }}
      />
      <motion.path
        d="M 750 160 C 640 160, 600 160, 500 160"
        fill="none"
        stroke="url(#wire-b)"
        strokeWidth="1.5"
        initial={{ pathLength: 0 }}
        animate={active ? { pathLength: 1 } : { pathLength: 0 }}
        transition={{ duration: t.draw, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.15 }}
      />

      {/* the shared environment */}
      <motion.g
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: t.node, delay: reduced ? 0 : 0.55 }}
      >
        <rect x="400" y="110" width="100" height="100" fill="#0f1216" stroke="#2b333c" />
        <rect x="400" y="110" width="100" height="16" fill="#14181d" stroke="#2b333c" />
        <text x="450" y="122" textAnchor="middle" className="fill-dim" fontSize="8" fontFamily="var(--font-jetbrains)" letterSpacing="1.4">
          ENV
        </text>
        {[0, 1, 2, 3].map((i) => (
          <motion.rect
            key={i}
            x={414}
            y={140 + i * 14}
            width={i === 3 ? 40 : 72}
            height="5"
            fill="#2b333c"
            initial={{ scaleX: 0 }}
            animate={active ? { scaleX: 1 } : { scaleX: 0 }}
            style={{ transformOrigin: "414px 0px" }}
            transition={{ duration: reduced ? 0 : 0.4, delay: reduced ? 0 : 0.75 + i * 0.07 }}
          />
        ))}
        {/* corner ticks */}
        <path d="M 400 118 L 400 110 L 408 110" fill="none" stroke="#4ecdc4" strokeWidth="1.5" opacity={ready ? 1 : 0.2} />
        <path d="M 492 210 L 500 210 L 500 202" fill="none" stroke="#e8a33d" strokeWidth="1.5" opacity={ready ? 1 : 0.2} />
      </motion.g>

      <AgentNode x={150} y={160} label="AGENT A" accent="#e8a33d" active={active} delay={reduced ? 0 : 0.3} reduced={reduced} />
      <AgentNode x={750} y={160} label="AGENT B" accent="#4ecdc4" active={active} delay={reduced ? 0 : 0.42} reduced={reduced} />

      {/* the task, named above the environment */}
      <motion.g
        initial={{ opacity: 0, y: 6 }}
        animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
        transition={{ duration: t.node, delay: reduced ? 0 : 1.0 }}
      >
        <line x1="450" y1="86" x2="450" y2="108" stroke="#2b333c" strokeWidth="1" />
        <text x="450" y="78" textAnchor="middle" className="fill-mid" fontSize="9" fontFamily="var(--font-jetbrains)" letterSpacing="1.6">
          ONE TASK
        </text>
        <text x="450" y="62" textAnchor="middle" className="fill-dim" fontSize="8" fontFamily="var(--font-jetbrains)" letterSpacing="1.2">
          IDENTICAL ENVIRONMENT
        </text>
      </motion.g>
    </svg>
  );
}

function AgentNode({
  x,
  y,
  label,
  accent,
  active,
  delay,
  reduced,
}: {
  x: number;
  y: number;
  label: string;
  accent: string;
  active: boolean;
  delay: number;
  reduced: boolean;
}) {
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.88 }}
      animate={active ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.88 }}
      transition={{ duration: reduced ? 0 : 0.55, ease: [0.16, 1, 0.3, 1], delay }}
      style={{ transformOrigin: `${x}px ${y}px` }}
    >
      <rect x={x - 46} y={y - 46} width="92" height="92" fill="#0a0c0e" stroke={accent} strokeOpacity="0.4" />
      <rect x={x - 38} y={y - 38} width="76" height="76" fill="none" stroke={accent} strokeOpacity="0.16" />
      <circle cx={x} cy={y} r="5" fill={accent} />
      <circle cx={x} cy={y} r="14" fill="none" stroke={accent} strokeOpacity="0.35" />
      <text
        x={x}
        y={y + 62}
        textAnchor="middle"
        fill={accent}
        fontSize="9"
        fontFamily="var(--font-jetbrains)"
        letterSpacing="1.8"
      >
        {label}
      </text>
    </motion.g>
  );
}
