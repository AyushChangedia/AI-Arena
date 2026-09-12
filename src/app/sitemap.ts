import type { MetadataRoute } from "next";
import { allTasks } from "@/lib/tasks";
import { getStore } from "@/lib/store";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const store = await getStore();
  const [agents, matches] = await Promise.all([
    store.listAgents({ visibility: "public" }),
    store.listMatches({ status: "complete", limit: 200 }),
  ]);

  const staticRoutes = ["", "/arena", "/leaderboard", "/agents", "/agents/new", "/tasks", "/matches", "/seasons", "/system"];

  return [
    ...staticRoutes.map((route) => ({
      url: `${SITE_URL}${route}`,
      lastModified: new Date(),
      changeFrequency: (route === "" || route === "/leaderboard" ? "hourly" : "daily") as "hourly" | "daily",
      priority: route === "" ? 1 : 0.7,
    })),
    ...allTasks().map((task) => ({
      url: `${SITE_URL}/tasks/${task.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...agents.map((agent) => ({
      url: `${SITE_URL}/agents/${agent.config.handle}`,
      lastModified: new Date(agent.updatedAt),
      changeFrequency: "daily" as const,
      priority: 0.6,
    })),
    ...matches.map((match) => ({
      url: `${SITE_URL}/matches/${match.id}`,
      lastModified: new Date(match.endedAt ?? match.createdAt),
      changeFrequency: "never" as const,
      priority: 0.4,
    })),
  ];
}
