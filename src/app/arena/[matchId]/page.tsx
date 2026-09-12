import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArenaStage } from "@/components/arena/ArenaStage";
import { getStore } from "@/lib/store";
import { ensureCustomTask, getTask } from "@/lib/tasks";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ matchId: string }>;
  searchParams: Promise<{ start?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { matchId } = await params;
  const store = await getStore();
  const match = await store.getMatch(matchId);
  if (!match) return { title: "Match not found" };
  ensureCustomTask(match);
  const task = getTask(match.taskId);
  const [a, b] = match.participants;
  return {
    title: `Match #${match.number} — ${a.configSnapshot.name} vs ${b.configSnapshot.name}`,
    description: `${a.configSnapshot.name} and ${b.configSnapshot.name} run "${task?.title ?? "a task"}" in identical environments.`,
  };
}

export default async function LiveArenaPage({ params, searchParams }: Props) {
  const { matchId } = await params;
  const { start } = await searchParams;

  const store = await getStore();
  const match = await store.getMatch(matchId);
  if (!match) notFound();

  // A match built from a typed brief carries that brief and nothing else —
  // rebuilding its task is what makes the page renderable at all. Live matches
  // arrive here rather than rendering in place, so without this every
  // model-driven custom brief 404s.
  ensureCustomTask(match);
  const task = getTask(match.taskId);
  if (!task) notFound();

  return <ArenaStage match={match} task={task} autoStart={start === "1"} />;
}
