import "server-only";
import { cookies, headers } from "next/headers";

/**
 * Who is asking.
 *
 * Every visitor gets an unguessable random id in an httpOnly cookie, minted by
 * `proxy.ts` on their first request. The id *is* the credential — the same
 * property a session token has — so there is no password to store, no secret to
 * rotate and nothing to leak in a database dump.
 *
 * This is authorization, not accounts. It answers "is this the same browser
 * that created the agent", which is what stops one visitor editing another's
 * work. It deliberately does not answer "who is this person": clearing cookies
 * means starting over, and there is no recovery. Adding real accounts later
 * means swapping what `viewerId` returns and nothing else.
 */

export const VIEWER_COOKIE = "arena_vid";
/** Set by the proxy so the very first request sees its own id, before the cookie exists. */
export const VIEWER_HEADER = "x-arena-viewer";

const PATTERN = /^v_[0-9a-f]{32}$/;

export function isViewerId(value: string | null | undefined): value is string {
  return typeof value === "string" && PATTERN.test(value);
}

export function mintViewerId(): string {
  return `v_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * The current viewer, or null when the request carried no identity at all.
 *
 * Reads the proxy's forwarded header first: a browser's very first request has
 * no cookie yet, and its `Set-Cookie` only takes effect on the next one, so
 * without the header the first agent anyone created would be unowned.
 */
export async function viewerId(): Promise<string | null> {
  const fromProxy = (await headers()).get(VIEWER_HEADER);
  if (isViewerId(fromProxy)) return fromProxy;

  const fromCookie = (await cookies()).get(VIEWER_COOKIE)?.value;
  return isViewerId(fromCookie) ? fromCookie : null;
}

/** True when this viewer may modify the thing that `ownerId` belongs to. */
export function owns(ownerId: string, viewer: string | null): boolean {
  return viewer !== null && ownerId === viewer;
}
