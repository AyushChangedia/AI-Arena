import { NextResponse } from "next/server";
import type { ZodType } from "zod";

/** Consistent JSON envelopes, so the client never has to guess a shape. */

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export type ApiErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unprocessable"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unprocessable: 422,
  internal: 500,
};

export function fail(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(details ? { details } : {}) } },
    { status: STATUS[code] },
  );
}

/** Parses and validates a JSON body, returning a typed value or a 400 response. */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ data: T; error: null } | { data: null; error: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { data: null, error: fail("bad_request", "Request body must be valid JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      data: null,
      error: fail(
        "unprocessable",
        "Some fields are invalid.",
        parsed.error.issues.map((i) => ({
          field: i.path.join(".") || "(root)",
          message: i.message,
        })),
      ),
    };
  }
  return { data: parsed.data, error: null };
}

/**
 * Wraps a handler so an unexpected throw becomes a clean 500, never a stack
 * trace. Generic over the response type so streaming handlers (SSE) can use it
 * too.
 */
export async function guard<R extends Response>(handler: () => Promise<R>): Promise<R | NextResponse> {
  try {
    return await handler();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[arena] unhandled API error:", e);
    return fail(
      "internal",
      process.env.NODE_ENV === "development"
        ? message
        : "Something went wrong handling that request.",
    );
  }
}
