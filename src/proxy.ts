import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { VIEWER_COOKIE, VIEWER_HEADER, isViewerId, mintViewerId } from "@/lib/server/identity";

/**
 * Gives every visitor a stable identity before anything renders.
 *
 * This is the `proxy.js` convention, which replaced `middleware.js` in
 * Next.js 16. It only *mints* the id — it never decides whether a request is
 * allowed. Authorization is enforced in the route handlers that mutate data,
 * because a matcher change or a moved route would silently remove proxy
 * coverage and take the only check with it.
 */
export function proxy(request: NextRequest) {
  const existing = request.cookies.get(VIEWER_COOKIE)?.value;
  const id = isViewerId(existing) ? existing : mintViewerId();

  // Forwarded on the request as well as set on the response: a first-time
  // visitor has no cookie yet and `Set-Cookie` only applies to their *next*
  // request, so without this the first agent they created would be unowned.
  const forwarded = new Headers(request.headers);
  forwarded.set(VIEWER_HEADER, id);

  const response = NextResponse.next({ request: { headers: forwarded } });

  if (id !== existing) {
    response.cookies.set(VIEWER_COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return response;
}

export const config = {
  // Everything except static assets and the generated image routes, which
  // carry no identity and would only pay the cost.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|woff2)$).*)"],
};
