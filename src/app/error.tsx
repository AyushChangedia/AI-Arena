"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, ButtonLink, Shell } from "@/components/ui/primitives";

/**
 * Users get a readable explanation; developers get the technical detail, but
 * only in development. A stack trace is never shown to a normal visitor.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[arena] page error:", error);
  }, [error]);

  const showDetail = process.env.NODE_ENV === "development";

  return (
    <Shell className="py-24">
      <div className="mx-auto max-w-xl">
        <p className="mono-label text-fail">Something broke</p>
        <h1 className="display mt-5 text-[clamp(30px,5vw,48px)] text-bright">
          The arena hit an error.
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-mid">
          This page could not be rendered. Any match already running is unaffected — the engine runs
          independently of this view, and its trace is persisted.
        </p>

        {showDetail ? (
          <pre className="mt-6 overflow-x-auto border border-fail/40 bg-fail-deep p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fail">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
        ) : error.digest ? (
          <p className="mono-label mt-6 text-dim">Reference {error.digest}</p>
        ) : null}

        <div className="mt-8 flex flex-wrap gap-3">
          <Button tone="primary" onClick={reset}>
            Try again
          </Button>
          <ButtonLink href="/">Back to the front</ButtonLink>
        </div>

        <p className="mt-8">
          <Link href="/system" className="mono-label text-dim transition-colors hover:text-a">
            Check system status
          </Link>
        </p>
      </div>
    </Shell>
  );
}
