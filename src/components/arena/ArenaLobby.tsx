"use client";

import { useState } from "react";
import type { Agent, Task } from "@/lib/arena/types";
import { Shell } from "@/components/ui/primitives";
import { MatchBuilder, type RanMatch } from "./MatchBuilder";
import { ArenaStage } from "./ArenaStage";

/**
 * The arena lobby, and the match it turns into.
 *
 * Pressing start runs the whole match in one request and swaps this screen for
 * the stage. There is no navigation in between, which is what makes it work on
 * a host where the next request may be served by a different instance than the
 * one that ran the match — the old create-then-navigate-then-start flow 404'd
 * there, because the match only ever existed in the instance that created it.
 *
 * The surrounding copy is passed in already rendered, so it stays on the server
 * and this component carries only the swap.
 */
export function ArenaLobby({
  agents,
  tasks,
  header,
  explainer,
  initialBrief = "",
}: {
  agents: Agent[];
  tasks: Task[];
  header: React.ReactNode;
  explainer: React.ReactNode;
  /** Carried from the front page when someone typed a brief there. */
  initialBrief?: string;
}) {
  const [ran, setRan] = useState<RanMatch | null>(null);

  if (ran) {
    return (
      <ArenaStage
        match={ran.match}
        task={ran.task}
        autoStart={false}
        recorded={ran.events}
        initialFinal={ran.final}
      />
    );
  }

  return (
    <Shell className="py-10">
      {header}
      <div className="mt-10">
        <MatchBuilder agents={agents} tasks={tasks} onRan={setRan} initialBrief={initialBrief} />
      </div>
      <div className="mt-14">{explainer}</div>
    </Shell>
  );
}
