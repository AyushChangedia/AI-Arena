/**
 * The public origin the site is served from.
 *
 * Canonical tags, the sitemap, robots.txt, Open Graph URLs and the JSON-LD
 * block all have to agree on this, so it is resolved once here rather than
 * copied into each of them.
 */

const DEV_FALLBACK = "http://localhost:3000";

/** Trim whitespace and any trailing slashes, and assume https when no scheme is given. */
function normalise(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Exported for tests; prefer the `SITE_URL` constant below.
 *
 * An explicit `NEXT_PUBLIC_SITE_URL` always wins — it is the only way to name a
 * custom domain. Failing that, Vercel exposes the project's *stable production*
 * domain, which is what a canonical URL wants. Deliberately not `VERCEL_URL`:
 * that is the per-deployment hostname, so canonical tags built from it would
 * point at a URL that every subsequent push supersedes, and each deployment
 * would declare itself the canonical copy of the site.
 */
export function resolveSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalise(env.NEXT_PUBLIC_SITE_URL) ||
    normalise(env.VERCEL_PROJECT_PRODUCTION_URL) ||
    DEV_FALLBACK
  );
}

export const SITE_URL = resolveSiteUrl();
