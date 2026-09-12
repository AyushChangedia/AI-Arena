"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { AgentConfig, AgentState } from "@/lib/arena/types";
import type { SideState, ToolActivity } from "./useMatchStream";
import { Chip, Emblem, cx, fmtMs } from "@/components/ui/primitives";

/**
 * One competitor's live panel.
 *
 * Every figure comes from the event stream. Before an agent has done anything
 * the readouts show em-dashes rather than zeros, because "no tool calls yet"
 * and "zero tool calls" are different claims.
 */

const STATE_COPY: Record<AgentState, { label: string; tone: "idle" | "work" | "warn" | "good" | "bad" }> = {
  idle: { label: "Idle", tone: "idle" },
  planning: { label: "Planning", tone: "work" },
  thinking: { label: "Thinking", tone: "work" },
  searching: { label: "Searching", tone: "work" },
  executing: { label: "Executing", tone: "work" },
  waiting: { label: "Waiting", tone: "idle" },
  recovering: { label: "Recovering", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  succeeded: { label: "Succeeded", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};

const TONE_CLASS = {
  idle: "text-dim border-line",
  work: "text-text border-line-strong",
  warn: "text-warn border-a-line bg-a-deep",
  good: "text-ok border-b-line bg-b-deep",
  bad: "text-fail border-fail/40 bg-fail-deep",
} as const;

export function AgentPanel({
  config,
  side,
  state,
  align = "left",
}: {
  config: AgentConfig;
  side: "A" | "B";
  state: SideState;
  align?: "left" | "right";
}) {
  const reduced = useReducedMotion();
  const copy = STATE_COPY[state.state];
  const right = align === "right";
  // Position colours the panel (A is amber, B is cyan, as in any broadcast);
  // the agent's own accent stays on the emblem, which is its identity.
  const accent: "amber" | "cyan" = side === "A" ? "amber" : "cyan";

  return (
    <section
      aria-label={`Agent ${side}: ${config.name}`}
      className="flex h-full min-w-0 flex-col border border-line bg-base"
    >
      {/* identity */}
      <header className={cx("flex items-start gap-3 border-b border-line p-4", right && "sm:flex-row-reverse sm:text-right")}>
        <Emblem emblem={config.emblem} accent={config.accent} size="md" />
        <div className="min-w-0 flex-1">
          <div className={cx("flex items-center gap-2", right && "sm:justify-end")}>
            <span className="mono-label text-dim">Agent {side}</span>
            {state.mode ? (
              <Chip tone={state.mode === "live" ? "cyan" : "muted"}>{state.mode}</Chip>
            ) : null}
          </div>
          <h2 className="display-tight mt-1 truncate text-xl text-text">{config.name}</h2>
          <p className="mono-label mt-1 truncate text-dim">{state.model ?? config.model.label}</p>
        </div>
      </header>

      {/* state */}
      <div className={cx("flex items-center gap-3 border-b border-line px-4 py-3", right && "sm:flex-row-reverse")}>
        <span
          className={cx(
            "mono-label inline-flex items-center gap-1.5 border px-2 py-1 transition-colors duration-300",
            TONE_CLASS[copy.tone],
          )}
        >
          {copy.tone === "work" ? (
            <span className="live-dot inline-block size-1.5 rounded-full bg-current" aria-hidden />
          ) : null}
          {copy.label}
        </span>
        <span className="tnum ml-auto font-mono text-sm text-dim">
          Step {String(state.step).padStart(2, "0")}
          {state.stepLimit ? <span className="text-dim">/{state.stepLimit}</span> : null}
        </span>
      </div>

      {/* current operation */}
      <div className="min-h-[92px] border-b border-line p-4">
        <AnimatePresence mode="wait">
          {state.currentTool ? (
            <motion.div
              key={state.currentTool.id}
              initial={reduced ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? undefined : { opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <ToolCard activity={state.currentTool} accent={accent} />
            </motion.div>
          ) : state.recentTools[0] ? (
            <motion.div
              key={state.recentTools[0].id}
              initial={reduced ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
            >
              <ToolCard activity={state.recentTools[0]} accent={accent} />
            </motion.div>
          ) : (
            <motion.p key="waiting" className="mono-label pt-6 text-center text-dim">
              Awaiting first action
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* telemetry */}
      <dl className="grid grid-cols-3 divide-x divide-line border-b border-line">
        <Readout label="Tools" value={state.toolsCalled || null} />
        <Readout label="Failed" value={state.toolsFailed || null} tone={state.toolsFailed > 0 ? "fail" : undefined} />
        <Readout
          label="Recovered"
          value={state.failures === 0 ? null : `${state.recoveries}/${state.failures}`}
          tone={state.recoveries > 0 ? "ok" : undefined}
        />
      </dl>

      {/* workspace */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mono-label mb-3 text-dim">Workspace</p>
        {state.files.length === 0 ? (
          <p className="text-xs text-dim">No files written yet.</p>
        ) : (
          <ul className="space-y-1.5">
            <AnimatePresence initial={false}>
              {state.files.map((file) => (
                <motion.li
                  key={file.path}
                  layout={!reduced}
                  initial={reduced ? false : { opacity: 0, x: right ? 8 : -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.22 }}
                  className="flex items-baseline gap-2 font-mono text-[11px]"
                >
                  <span
                    className={cx(
                      "shrink-0",
                      file.kind === "created" ? (accent === "amber" ? "text-a" : "text-b") : "text-dim",
                    )}
                  >
                    {file.kind === "created" ? "+" : "~"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-mid" title={file.path}>
                    {file.path}
                  </span>
                  <span className="tnum shrink-0 text-dim">{formatBytes(file.bytes)}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      {/* closing statement */}
      {state.message ? (
        <div className="border-t border-line p-4">
          <p className="mono-label mb-2 text-dim">Agent says</p>
          <p className="line-clamp-4 text-xs leading-relaxed text-mid">{state.message}</p>
        </div>
      ) : null}
    </section>
  );
}

function Readout({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number | null;
  tone?: "fail" | "ok";
}) {
  return (
    <div className="px-3 py-3">
      <dt className="mono-label text-dim">{label}</dt>
      <dd
        className={cx(
          "tnum mt-1 font-mono text-base",
          value === null ? "text-dim" : tone === "fail" ? "text-fail" : tone === "ok" ? "text-ok" : "text-text",
        )}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

export function ToolCard({ activity, accent }: { activity: ToolActivity; accent: "amber" | "cyan" | "neutral" }) {
  const border =
    activity.status === "error"
      ? "border-fail/50"
      : activity.status === "pending"
        ? accent === "amber"
          ? "border-a-line"
          : "border-b-line"
        : "border-line-strong";

  return (
    <div className={cx("relative overflow-hidden border bg-surface px-3 py-2.5", border)}>
      {activity.status === "pending" ? (
        <span
          className="sweep absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent via-white/[0.05] to-transparent"
          aria-hidden
        />
      ) : null}
      <div className="relative flex items-center justify-between gap-3">
        <span className="mono-label truncate text-text">{activity.tool}</span>
        <span className="mono-label shrink-0">
          {activity.status === "pending" ? (
            <span className="text-dim">running</span>
          ) : activity.status === "error" ? (
            <span className="text-fail">failed</span>
          ) : (
            <span className="text-ok">done</span>
          )}
        </span>
      </div>
      {activity.detail ? (
        <p className="relative mt-1.5 truncate font-mono text-[11px] text-dim" title={activity.detail}>
          {activity.detail}
        </p>
      ) : null}
      <div className="relative mt-2 flex items-center gap-2">
        {activity.durationMs !== null ? (
          <span className="tnum font-mono text-[10px] text-dim">{fmtMs(activity.durationMs)}</span>
        ) : null}
        {activity.provenance === "offline-corpus" ? (
          <Chip tone="muted" title="Results came from the bundled document corpus, not the live web.">
            Offline corpus
          </Chip>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}
