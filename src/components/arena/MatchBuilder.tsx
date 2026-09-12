"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Shuffle } from "lucide-react";
import type { Agent, Task } from "@/lib/arena/types";
import { Button, Chip, Emblem, cx } from "@/components/ui/primitives";

/**
 * Pick two agents and a task.
 *
 * The panel shows the asymmetry between the chosen agents *before* they run —
 * different tool sets, different step ceilings, different planning depth — so
 * the result is read against what they were configured to do rather than as a
 * bare verdict on their models.
 */

export function MatchBuilder({ agents, tasks }: { agents: Agent[]; tasks: Task[] }) {
  const router = useRouter();
  const [agentA, setAgentA] = useState<string>(agents[0]?.id ?? "");
  const [agentB, setAgentB] = useState<string>(agents[1]?.id ?? "");
  const [taskId, setTaskId] = useState<string>(tasks[0]?.id ?? "");
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

  const blocked = !a || !b || !task || sameAgent || toolGap?.emptyA || toolGap?.emptyB;

  async function start() {
    if (blocked || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, agentAId: agentA, agentBId: agentB }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        data?: { id: string };
        error?: { message: string };
      };
      if (!body.ok || !body.data) {
        setError(body.error?.message ?? "The match could not be created.");
        setPending(false);
        return;
      }
      router.push(`/arena/${body.data.id}?start=1`);
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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)]">
      <AgentColumn
        label="Agent A"
        agents={agents}
        selectedId={agentA}
        otherId={agentB}
        onSelect={setAgentA}
        accent="amber"
      />

      <div className="order-first flex flex-col gap-4 lg:order-none">
        <div className="border border-line bg-base">
          <div className="border-b border-line px-4 py-2.5">
            <span className="mono-label text-dim">Task</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto p-2">
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
        </div>

        {task ? (
          <div className="border border-line bg-base p-4">
            <p className="text-[13px] leading-relaxed text-dim">{task.brief}</p>
            <dl className="mt-4 grid grid-cols-3 gap-px bg-line">
              <Fact label="Steps" value={String(task.limits.stepLimit)} />
              <Fact label="Time" value={`${Math.round(task.limits.timeLimitMs / 1000)}s`} />
              <Fact label="Budget" value={`$${task.limits.budgetUsd.toFixed(2)}`} />
            </dl>
          </div>
        ) : null}

        {toolGap && !sameAgent ? (
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
            {pending ? "Preparing…" : "Start match"}
            {!pending ? <ArrowRight size={13} aria-hidden /> : null}
          </Button>
          <Button onClick={randomise} title="Pick a random pairing">
            <Shuffle size={13} aria-hidden />
          </Button>
        </div>
      </div>

      <AgentColumn
        label="Agent B"
        agents={agents}
        selectedId={agentB}
        otherId={agentA}
        onSelect={setAgentB}
        accent="cyan"
      />
    </div>
  );
}

function AgentColumn({
  label,
  agents,
  selectedId,
  otherId,
  onSelect,
  accent,
}: {
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
        <div className="border-b border-line px-4 py-2.5">
          <span className={cx("mono-label", accent === "amber" ? "text-a" : "text-b")}>{label}</span>
        </div>
        <div className="max-h-[280px] overflow-y-auto p-2">
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
