/**
 * Development helper: runs a spread of real matches against a running server so
 * the leaderboard, profiles and match history have genuine data to render.
 * Not part of the app — delete it or keep it as a smoke test.
 */
const BASE = process.env.ARENA_URL ?? "http://localhost:3000";
const j = async (url, opts) => (await fetch(BASE + url, opts)).json();

const agents = (await j("/api/agents")).data;
const tasks = (await j("/api/tasks")).data;
const byHandle = Object.fromEntries(agents.map((a) => [a.config.handle, a.id]));
const bySlug = Object.fromEntries(tasks.map((t) => [t.slug, t.id]));

const pairs = [
  ["repair-auth", "architect", "speedrunner"],
  ["rate-limiter", "debugger", "shipper"],
  ["landing-page", "architect", "generalist"],
  ["vector-db-research", "research-beast", "shipper"],
  ["sales-analysis", "debugger", "speedrunner"],
  ["oncall-rotation", "generalist", "architect"],
  ["repair-auth", "debugger", "generalist"],
  ["rate-limiter", "architect", "speedrunner"],
  ["landing-page", "shipper", "speedrunner"],
  ["oncall-rotation", "research-beast", "debugger"],
  ["vector-db-research", "generalist", "architect"],
  ["sales-analysis", "research-beast", "shipper"],
];

for (const [slug, a, b] of pairs) {
  const created = await j("/api/matches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: bySlug[slug], agentAId: byHandle[a], agentBId: byHandle[b] }),
  });
  if (!created.ok) {
    console.log("create failed:", created.error);
    continue;
  }
  await j(`/api/matches/${created.data.id}/start`, { method: "POST" });
  await new Promise((r) => setTimeout(r, 500));
  const detail = await j(`/api/matches/${created.data.id}`);
  const m = detail.data.match;
  const scores = detail.data.sides.map((s) => s.score?.total?.toFixed(1) ?? "—").join(" : ");
  console.log(`#${m.number} ${slug.padEnd(19)} ${a.padEnd(14)} vs ${b.padEnd(12)} → ${String(m.result).padEnd(5)} ${scores}`);
}
