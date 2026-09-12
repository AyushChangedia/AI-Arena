import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArenaStage } from "@/components/arena/ArenaStage";
import { getStore } from "@/lib/store";
import { getTask } from "@/lib/tasks";

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

  const task = getTask(match.taskId);
  if (!task) notFound();

  return <ArenaStage match={match} task={task} autoStart={start === "1"} />;
}
