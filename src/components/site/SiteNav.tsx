"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { cx } from "@/components/ui/primitives";

const LINKS = [
  { href: "/arena", label: "Arena" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/agents", label: "Agents" },
  { href: "/tasks", label: "Tasks" },
  { href: "/matches", label: "Matches" },
  { href: "/seasons", label: "Seasons" },
];

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-void/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1400px] items-center gap-6 px-5 py-3 sm:px-8">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5" onClick={() => setOpen(false)}>
          <span className="grid size-6 place-items-center border border-a-line bg-a-deep">
            <span className="block size-1.5 bg-a transition-transform duration-300 group-hover:scale-150" />
          </span>
          <span className="display text-[15px] tracking-tight text-text">
            AI Agent Arena
          </span>
        </Link>

        <nav aria-label="Primary" className="ml-auto hidden items-center gap-1 md:flex">
          {LINKS.map((link) => {
            const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cx(
                  "mono-label px-3 py-2 transition-colors",
                  active ? "text-a" : "text-dim hover:text-text",
                )}
              >
                {link.label}
              </Link>
            );
          })}
          <Link
            href="/agents/new"
            className="mono-label ml-2 border border-a bg-a px-3 py-2 text-void transition-colors hover:bg-[#f2b862]"
          >
            Build agent
          </Link>
        </nav>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto grid size-9 place-items-center border border-line-strong text-mid md:hidden"
        >
          {open ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
        </button>
      </div>

      {open ? (
        <nav aria-label="Primary" className="border-t border-line bg-base md:hidden">
          <ul className="px-5 py-2">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="mono-label block border-b border-line py-3 text-dim"
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/agents/new"
                onClick={() => setOpen(false)}
                className="mono-label block py-3 text-a"
              >
                Build agent
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
