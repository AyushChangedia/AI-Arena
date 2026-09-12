/**
 * Fixed-window rate limiter for API writes.
 *
 * In-process, like the event bus. It bounds a single instance; a deployment
 * behind several instances wants a shared store, and the interface is the seam.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
const MAX_KEYS = 5_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size > MAX_KEYS) sweep(now);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetInMs: windowMs };
  }

  existing.count += 1;
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetInMs: existing.resetAt - now,
  };
}

/** Best-effort client key. There is no auth, so this is per-connection at best. */
export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip");
  return `${scope}:${forwarded || real || "local"}`;
}

function sweep(now: number): void {
  for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
}

/** Test seam. */
export function resetRateLimits(): void {
  windows.clear();
}
