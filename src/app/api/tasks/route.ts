import type { NextRequest } from "next/server";
import { allTasks } from "@/lib/tasks";
import { guard, ok } from "@/lib/server/api";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return guard(async () => {
    const category = request.nextUrl.searchParams.get("category");
    const tasks = category ? allTasks().filter((t) => t.category === category) : allTasks();
    return ok(tasks);
  });
}
