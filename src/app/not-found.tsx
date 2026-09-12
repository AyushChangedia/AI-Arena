import Link from "next/link";
import { ButtonLink, Shell } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <Shell className="py-24">
      <div className="mx-auto max-w-lg text-center">
        <p className="mono-label text-dim">404</p>
        <h1 className="display mt-5 text-[clamp(34px,6vw,58px)] text-bright">Nothing here.</h1>
        <p className="mt-5 text-[15px] leading-relaxed text-mid">
          That agent, match or task does not exist. It may have been a match that never ran, or an
          agent that was deleted.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/arena" tone="primary">
            Enter the arena
          </ButtonLink>
          <ButtonLink href="/matches">Match history</ButtonLink>
        </div>
        <p className="mt-8">
          <Link href="/" className="mono-label text-dim transition-colors hover:text-a">
            Back to the front
          </Link>
        </p>
      </div>
    </Shell>
  );
}
