"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * The start.
 *
 * Four verification lines, then three numbers, then GO. Each check corresponds
 * to something the engine actually does before step one — the environments are
 * materialised and hash-compared, the configs are pinned, the task is resolved —
 * so the sequence is a readout, not theatre for its own sake.
 *
 * Reduced motion skips straight to GO.
 */

const CHECKS = [
  "Match initializing",
  "Agents locked",
  "Task verified",
  "Environment synced",
] as const;

export function Countdown({ onComplete }: { onComplete: () => void }) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<number>(reduced ? CHECKS.length + 4 : 0);

  useEffect(() => {
    if (reduced) {
      onComplete();
      return;
    }
    if (phase > CHECKS.length + 3) {
      const timer = setTimeout(onComplete, 380);
      return () => clearTimeout(timer);
    }
    const delay = phase < CHECKS.length ? 300 : 620;
    const timer = setTimeout(() => setPhase((p) => p + 1), delay);
    return () => clearTimeout(timer);
  }, [phase, reduced, onComplete]);

  if (reduced) return null;

  const counting = phase >= CHECKS.length;
  const number = counting ? 3 - (phase - CHECKS.length) : null;

  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center bg-void/96 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="status"
      aria-live="polite"
    >
      <div className="grid-field pointer-events-none absolute inset-0 opacity-25" aria-hidden />

      <div className="relative flex w-full max-w-md flex-col items-center px-6">
        <ul className="w-full space-y-2">
          {CHECKS.map((check, index) => {
            const done = phase > index;
            return (
              <li
                key={check}
                className={`mono-label flex items-center justify-between border-b border-line py-2.5 transition-colors duration-200 ${
                  done ? "text-text" : "text-dim/40"
                }`}
              >
                <span>{check}</span>
                <span className={done ? "text-ok" : "text-dim/40"}>{done ? "OK" : "…"}</span>
              </li>
            );
          })}
        </ul>

        <div className="mt-10 grid h-32 w-full place-items-center">
          <AnimatePresence mode="wait">
            {number !== null && number > 0 ? (
              <motion.span
                key={number}
                className="display text-[96px] leading-none text-text"
                initial={{ opacity: 0, scale: 1.35 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {number}
              </motion.span>
            ) : number !== null ? (
              <motion.span
                key="go"
                className="display text-[96px] leading-none text-a"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              >
                GO
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
