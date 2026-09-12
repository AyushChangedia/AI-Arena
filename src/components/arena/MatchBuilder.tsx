"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Shuffle } from "lucide-react";
import type { Agent, Artifact, ExecutionEvent, Match, ScoreDimension, Side, Task } from "@/lib/arena/types";
import { BRIEF_MAX, BRIEF_MIN } from "@/lib/tasks/brief";
import { Button, Chip, Emblem, cx } from "@/components/ui/primitives";

/**
 * Pick two agents and a task.
 *
 * The panel shows the asymmetry between the chosen agents *before* they run —
 * different tool sets, different step ceilings, different planning depth — so
 * the result is read against what they were configured to do rather than as a
 * bare verdict on their models.
 */

/** Everything needed to render a finished match without another request. */
export interface RanMatch {
  match: Match;
  /**
   * Taken from the response, not looked up by id. A match built from a typed
   * brief has a task that exists only for that brief, so it is not in the
   * library the picker was given.
   */
  task: Task;
  events: ExecutionEvent[];
  final: Record<Side, FinalSide>;
}

interface FinalSide {
  total: number | null;
  dimensions: ScoreDimension[];
  ratingBefore: number;
  ratingAfter: number | null;
  artifacts: Artifact[];
}

type RunResponse =
  | { streamInstead: true; matchId: string }
  | {
      streamInstead: false;
      match: Match;
      task: Task | null;
      events: ExecutionEvent[];
      sides: {
        side: Side;
        score: { total: number; dimensions: ScoreDimension[] } | null;
        ratingBefore: number;
        ratingAfter: number | null;
        artifacts: Artifact[];
      }[];
    };

export function MatchBuilder({
  agents,
  tasks,
  onRan,
  initialBrief = "",
}: {
  agents: Agent[];
  tasks: Task[];
  onRan: (ran: RanMatch) => void;
  /** Prefilled when someone arrived from the front page having typed a brief. */
  initialBrief?: string;
}) {
  const router = useRouter();
  const [agentA, setAgentA] = useState<string>(agents[0]?.id ?? "");
  const [agentB, setAgentB] = useState<string>(agents[1]?.id ?? "");
  const [taskId, setTaskId] = useState<string>(tasks[0]?.id ?? "");
  const [source, setSource] = useState<"library" | "brief">(initialBrief ? "brief" : "library");
  const [brief, setBrief] = useState(initialBrief);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const a = agents.find((x) => x.id === agentA) ?? null;
  const b = agents.find((x) => x.id === agentB) ?? null;
  const task = tasks.find((t) => t.id === taskId) ?? null;

  const sameAgent = Boolean(agentA) && agentA === agentB;

  const toolGap = useMemo(() => {
    if (!a || !b || !task) return null;
    const allowed = new Set(task.toolsAllowed);
    const forA = a.config.tools.filter((t) => allowed.has(t));
    const forB = b.config.tools.filter((t) => allowed.has(t));
    return {
      onlyA: forA.filter((t) => !forB.includes(t)),
      onlyB: forB.filter((t) => !forA.includes(t)),
      shared: forA.filter((t) => forB.includes(t)),
      emptyA: forA.length === 0,
      emptyB: forB.length === 0,
    };
  }, [a, b, task]);

  const usingBrief = source === "brief";
  const briefTooShort = usingBrief && brief.trim().length < BRIEF_MIN;
  const blocked =
    !a ||
    !b ||
    sameAgent ||
    (usingBrief ? briefTooShort : !task) ||
    // Tool gaps only mean something against a known task's allow-list.
    (!usingBrief && (toolGap?.emptyA || toolGap?.emptyB));

  /**
   * Run the match in a single request and show it here.
   *
   * The old flow created the match, navigated to /arena/<id> and started it
   * there. That needs three requests to agree on where the match lives, which
   * holds on one long-lived process and fails on a serverless host: the match
   * exists only in the instance that created it, so the page it navigated to
   * would 404. Running and rendering in place removes the shared state from the
   * critical path entirely. A model-driven match still needs the stream, and
   * the server says so.
   */
  async function start() {
    if (blocked || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/matches/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          usingBrief
            ? { brief: brief.trim(), agentAId: agentA, agentBId: agentB }
            : { taskId, agentAId: agentA, agentBId: agentB },
        ),
      });
      const body = (await response.json()) as {
        ok: boolean;
        data?: RunResponse;
        error?: { message: string };
      };
      if (!body.ok || !body.data) {
        setError(body.error?.message ?? "The match could not be run.");
        setPending(false);
        return;
      }
      if (body.data.streamInstead) {
        router.push(`/arena/${body.data.matchId}?start=1`);
        return;
      }
      const ran = body.data;
      // From the response, not the picker: a brief's task exists only for that
      // brief and is not in the library this component was handed.
      const ranTask = ran.task ?? tasks.find((t) => t.id === ran.match.taskId);
      if (!ranTask) {
        setError("The match ran but its task could not be read back.");
        setPending(false);
        return;
      }

      const final = {} as Record<Side, FinalSide>;
      for (const side of ran.sides) {
        final[side.side] = {
          total: side.score?.total ?? null,
          dimensions: side.score?.dimensions ?? [],
          ratingBefore: side.ratingBefore,
          ratingAfter: side.ratingAfter,
          artifacts: side.artifacts,
        };
      }
      onRan({ match: ran.match, task: ranTask, events: ran.events, final });
    } catch {
      setError("Could not reach the arena. Check the server is running.");
      setPending(false);
    }
  }

  function randomise() {
    if (agents.length < 2 || tasks.length === 0) return;
    const shuffled = [...agents].sort(() => Math.random() - 0.5);
    setAgentA(shuffled[0]!.id);
    setAgentB(shuffled[1]!.id);
    setTaskId(tasks[Math.floor(Math.random() * tasks.length)]!.id);
  }

  return (
    <div className="flex flex-col gap-4 lg:grid lg:items-start lg:gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)]">
      <div className="order-2 lg:order-none lg:col-start-1 lg:row-start-1">
        <AgentColumn
          step={2}
          label="Agent A"
          agents={agents}
          selectedId={agentA}
          otherId={agentB}
          onSelect={setAgentA}
          accent="amber"
        />
      </div>

      <div className="order-1 flex flex-col gap-4 lg:order-none lg:col-start-2 lg:row-start-1">
        <div className="border border-line bg-base">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <StepBadge n={1} />
            <span className="mono-label text-dim">Choose the job</span>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-line bg-line">
            {(
              [
                ["library", "Task library"],
                ["brief", "Write your own"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setSource(value)}
                aria-pressed={source === value}
                className={cx(
                  "mono-label px-3 py-2.5 transition-colors",
                  source === value ? "bg-surface text-a" : "bg-base text-dim hover:text-mid",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {usingBrief ? (
            <div className="p-4">
              <label htmlFor="brief" className="mono-label block text-dim">
                What should they build?
              </label>
              <textarea
                id="brief"
                value={brief}
                onChange={(e) => setBrief(e.target.value.slice(0, BRIEF_MAX))}
                rows={5}
                placeholder="Build me a coffee shop landing page for a roastery called Ember, with a menu and opening hours."
                className="mt-2 w-full resize-y border border-line bg-void px-3 py-2.5 text-sm leading-relaxed text-text outline-none placeholder:text-dim focus:border-line-strong"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="mono-label text-dim">
                  {briefTooShort ? `At least ${BRIEF_MIN} characters` : "Both agents get this verbatim"}
                </span>
                <span className="tnum font-mono text-[11px] text-dim">
                  {brief.trim().length}/{BRIEF_MAX}
                </span>
              </div>
              <p className="mt-4 border-t border-line pt-3 text-[13px] leading-relaxed text-dim">
                Your brief has no answer key, so it is graded on what can be checked without one:
                the artifact exists, it is structurally sound, and it is
                <span className="text-mid"> about what you asked for</span>. That is a weaker
                signal than the library tasks, which assert correctness.
              </p>
            </div>
          ) : (
          <div className="p-2 lg:max-h-[280px] lg:overflow-y-auto">
            {tasks.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTaskId(t.id)}
                aria-pressed={taskId === t.id}
                className={cx(
                  "block w-full border px-3 py-2.5 text-left transition-colors",
                  taskId === t.id
                    ? "border-line-strong bg-surface"
                    : "border-transparent hover:bg-surface/60",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cx("truncate text-sm", taskId === t.id ? "text-text" : "text-mid")}>
                    {t.title}
                  </span>
                  <Chip tone="muted" className="ml-auto shrink-0">
                    {t.difficulty}
                  </Chip>
                </span>
                <span className="mono-label mt-1 block text-dim">{t.category}</span>
              </button>
            ))}
          </div>
          )}
        </div>

        {task && !usingBrief ? (
          <div className="border border-line bg-base p-4">
            <p className="text-[13px] leading-relaxed text-dim">{task.brief}</p>
            <dl className="mt-4 grid grid-cols-3 gap-px bg-line">
              <Fact label="Steps" value={String(task.limits.stepLimit)} />
              <Fact label="Time" value={`${Math.round(task.limits.timeLimitMs / 1000)}s`} />
              <Fact label="Budget" value={`$${task.limits.budgetUsd.toFixed(2)}`} />
            </dl>
          </div>
        ) : null}

        {toolGap && !sameAgent && !usingBrief ? (
          <div className="border border-line bg-base p-4">
            <p className="mono-label mb-3 text-dim">Before they start</p>
            {toolGap.emptyA || toolGap.emptyB ? (
              <p className="text-[13px] leading-relaxed text-fail">
                {toolGap.emptyA ? a?.config.name : b?.config.name} has no tool this task allows, so it
                could not act at all. Pick a different agent or a different task.
              </p>
            ) : toolGap.onlyA.length === 0 && toolGap.onlyB.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-dim">
                Identical tool sets — {toolGap.shared.length} tools each. Any difference in the result
                comes from how they use them.
              </p>
            ) : (
              <div className="space-y-2 text-[13px] leading-relaxed text-dim">
                <p>
                  These agents do not carry the same tools. That is a property of how they were built,
                  not a handicap the arena applied.
                </p>
                {toolGap.onlyA.length > 0 ? (
                  <p>
                    <span className="text-a">{a?.config.name}</span> only:{" "}
                    <span className="font-mono text-mid">{toolGap.onlyA.join(", ")}</span>
                  </p>
                ) : null}
                {toolGap.onlyB.length > 0 ? (
                  <p>
                    <span className="text-b">{b?.config.name}</span> only:{" "}
                    <span className="font-mono text-mid">{toolGap.onlyB.join(", ")}</span>
                  </p>
                ) : null}
              </div>
            )}
          </div>
        ) : null}

      </div>

      <div className="order-3 lg:order-none lg:col-start-3 lg:row-start-1">
        <AgentColumn
          step={3}
          label="Agent B"
          agents={agents}
          selectedId={agentB}
          otherId={agentA}
          onSelect={setAgentB}
          accent="cyan"
        />
      </div>

      {/* Anything that blocks the match sits with the button it blocks, rather
          than scrolled off above two agent pickers. */}
      <div className="order-4 flex flex-col gap-3 lg:col-start-2 lg:row-start-2">
        {sameAgent ? (
          <p className="border border-fail/40 bg-fail-deep px-4 py-3 text-[13px] text-fail">
            An agent cannot face itself. Pick a different opponent.
          </p>
        ) : null}

        {error ? (
          <p className="border border-fail/40 bg-fail-deep px-4 py-3 text-[13px] text-fail">{error}</p>
        ) : null}

        <div className="flex gap-3">
          <Button tone="primary" onClick={start} disabled={Boolean(blocked) || pending} className="flex-1">
            {pending ? "Running the match…" : "Start match"}
            {!pending ? <ArrowRight size={13} aria-hidden /> : null}
          </Button>
          <Button onClick={randomise} title="Pick a random pairing" aria-label="Pick a random pairing">
            <Shuffle size={13} aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

function AgentColumn({
  step,
  label,
  agents,
  selectedId,
  otherId,
  onSelect,
  accent,
}: {
  step: number;
  label: string;
  agents: Agent[];
  selectedId: string;
  otherId: string;
  onSelect: (id: string) => void;
  accent: "amber" | "cyan";
}) {
  const selected = agents.find((a) => a.id === selectedId);

  return (
    <div className="flex flex-col gap-4">
      <div className="border border-line bg-base">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <StepBadge n={step} />
          <span className={cx("mono-label", accent === "amber" ? "text-a" : "text-b")}>{label}</span>
        </div>
        <div className="p-2 lg:max-h-[280px] lg:overflow-y-auto">
          {agents.map((agent) => {
            const isOther = agent.id === otherId;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelect(agent.id)}
                aria-pressed={selectedId === agent.id}
                disabled={isOther}
                className={cx(
                  "flex w-full items-center gap-3 border px-3 py-2.5 text-left transition-colors",
                  selectedId === agent.id
                    ? "border-line-strong bg-surface"
                    : "border-transparent hover:bg-surface/60",
                  isOther && "cursor-not-allowed opacity-30 hover:bg-transparent",
                )}
              >
                <Emblem emblem={agent.config.emblem} accent={agent.config.accent} size="sm" />
                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      "block truncate text-sm",
                      selectedId === agent.id ? "text-text" : "text-mid",
                    )}
                  >
                    {agent.config.name}
                  </span>
                  <span className="mono-label block truncate text-dim">{agent.config.model.label}</span>
                </span>
                {agent.origin === "user" ? <Chip tone="muted">Yours</Chip> : null}
              </button>
            );
          })}
        </div>
      </div>

      {selected ? (
        <div className="border border-line bg-base p-4">
          <p className="text-[13px] leading-relaxed text-dim">{selected.config.tagline}</p>
          <dl className="mt-4 grid grid-cols-3 gap-px bg-line">
            <Fact label="Planning" value={selected.config.planning} />
            <Fact label="Steps" value={String(selected.config.maxSteps)} />
            <Fact label="Budget" value={`$${selected.config.budgetUsd.toFixed(2)}`} />
          </dl>
          <p className="mono-label mt-4 text-dim">Tools</p>
          <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-mid">
            {selected.config.tools.join("  ")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-void px-2.5 py-2.5">
      <dt className="mono-label text-dim">{label}</dt>
      <dd className="tnum mt-1 truncate font-mono text-[13px] text-mid">{value}</dd>
    </div>
  );
}

/** The numeral in a panel header, so the three steps read in order. */
function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex size-[18px] shrink-0 items-center justify-center border border-line-strong bg-surface font-mono text-[10px] leading-none text-mid">
      {n}
    </span>
  );
}
