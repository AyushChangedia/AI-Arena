export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe for orchestrators and the container healthcheck.
 *
 * Deliberately does no work: it answers "is this process serving?" and nothing
 * else. Readiness detail — providers, sandbox, persistence — lives at
 * /api/system, which is a heavier call and not what a health loop should hit
 * every thirty seconds.
 */
export function GET() {
  return Response.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
}
