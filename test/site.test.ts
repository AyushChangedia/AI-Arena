import { describe, expect, it } from "vitest";
import { resolveSiteUrl } from "@/lib/site";

/**
 * The origin feeds canonical tags, the sitemap and Open Graph URLs. A wrong
 * value here is invisible in the UI and poisons every one of them, so the
 * resolution order is pinned.
 */

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("resolveSiteUrl", () => {
  it("falls back to the dev server when nothing is configured", () => {
    expect(resolveSiteUrl(env({}))).toBe("http://localhost:3000");
  });

  it("prefers an explicit site URL over the platform's", () => {
    expect(
      resolveSiteUrl(
        env({
          NEXT_PUBLIC_SITE_URL: "https://arena.example.com",
          VERCEL_PROJECT_PRODUCTION_URL: "whatever.vercel.app",
        }),
      ),
    ).toBe("https://arena.example.com");
  });

  it("uses Vercel's production domain when no explicit URL is set", () => {
    expect(resolveSiteUrl(env({ VERCEL_PROJECT_PRODUCTION_URL: "arena.vercel.app" }))).toBe(
      "https://arena.vercel.app",
    );
  });

  it("never builds an origin from the per-deployment hostname", () => {
    // VERCEL_URL changes with every push. Canonical tags built from it would
    // make each deployment claim to be the canonical copy of the site.
    expect(resolveSiteUrl(env({ VERCEL_URL: "arena-abc123-team.vercel.app" }))).toBe(
      "http://localhost:3000",
    );
  });

  it("adds a scheme to a bare hostname", () => {
    expect(resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "arena.example.com" }))).toBe(
      "https://arena.example.com",
    );
  });

  it("keeps an explicit http scheme rather than forcing https", () => {
    expect(resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "http://localhost:4000" }))).toBe(
      "http://localhost:4000",
    );
  });

  it("strips trailing slashes so joined paths do not double up", () => {
    const url = resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "https://arena.example.com///" }));
    expect(url).toBe("https://arena.example.com");
    expect(`${url}/tasks`).toBe("https://arena.example.com/tasks");
  });

  it("treats a blank or whitespace value as unset", () => {
    expect(
      resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "   ", VERCEL_PROJECT_PRODUCTION_URL: "arena.vercel.app" })),
    ).toBe("https://arena.vercel.app");
    expect(resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: "" }))).toBe("http://localhost:3000");
  });

  it("produces a value that URL accepts, since metadataBase parses it", () => {
    for (const value of ["arena.example.com", "https://arena.example.com/", undefined]) {
      expect(() => new URL(resolveSiteUrl(env({ NEXT_PUBLIC_SITE_URL: value })))).not.toThrow();
    }
  });
});
