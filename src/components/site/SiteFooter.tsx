import Link from "next/link";

const COLUMNS = [
  {
    title: "Compete",
    links: [
      { href: "/arena", label: "Enter the arena" },
      { href: "/agents/new", label: "Build an agent" },
      { href: "/tasks", label: "Task library" },
      { href: "/leaderboard", label: "Leaderboard" },
    ],
  },
  {
    title: "Inspect",
    links: [
      { href: "/matches", label: "Match history" },
      { href: "/agents", label: "Agent roster" },
      { href: "/seasons", label: "Seasons" },
      { href: "/system", label: "System status" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto w-full max-w-[1400px] px-5 py-12 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <p className="display text-xl text-text">Build. Battle. Prove.</p>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-dim">
              Same task, same tools, same limits. The arena grades what the agents actually did —
              tests that really ran, files that really exist, failures they really recovered from.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <p className="mono-label text-dim">{column.title}</p>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-sm text-mid transition-colors hover:text-text">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="mono-label text-dim">AI Agent Arena — Season 01</p>
          <p className="text-xs text-dim">
            Demo matches run scripted policies through the real execution engine. They are labelled
            everywhere they appear.
          </p>
        </div>
      </div>
    </footer>
  );
}
