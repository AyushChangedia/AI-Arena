import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Design primitives.
 *
 * Deliberately few. Hierarchy comes from type, space and hairlines — not from
 * a deep stack of nested card components.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ─── labels ─────────────────────────────────────────────────────────────────

type ChipTone = "neutral" | "amber" | "cyan" | "fail" | "live" | "muted";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "border-line-strong text-mid",
  muted: "border-line text-dim",
  amber: "border-a-line text-a bg-a-deep",
  cyan: "border-b-line text-b bg-b-deep",
  fail: "border-fail/40 text-fail bg-fail-deep",
  live: "border-fail/50 text-fail bg-fail-deep",
};

export function Chip({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "mono-label inline-flex items-center gap-1.5 border px-1.5 py-0.5 leading-none whitespace-nowrap",
        CHIP_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function LiveChip({ label = "Live" }: { label?: string }) {
  return (
    <Chip tone="live">
      <span className="live-dot inline-block size-1.5 rounded-full bg-fail" aria-hidden />
      {label}
    </Chip>
  );
}

/**
 * The single most important label in the product: it separates a run driven by
 * a real model from one driven by a scripted policy.
 */
export function ModeChip({ mode }: { mode: "live" | "demo" }) {
  return mode === "live" ? (
    <Chip tone="cyan" title="A model provider made every decision in this match.">
      Live
    </Chip>
  ) : (
    <Chip
      tone="muted"
      title="Scripted policy, real execution: real tools, real sandbox, real graders — the decisions were pre-authored rather than sampled from a model."
    >
      Demo
    </Chip>
  );
}

// ─── structure ──────────────────────────────────────────────────────────────

export function Panel({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "aside";
}) {
  return <Tag className={cx("ticked border border-line bg-base", className)}>{children}</Tag>;
}

export function SectionRule({
  label,
  right,
  className,
}: {
  label: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center gap-4", className)}>
      <span className="mono-label text-dim">{label}</span>
      <span className="h-px flex-1 bg-line" aria-hidden />
      {right}
    </div>
  );
}

export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-[1400px] px-5 sm:px-8", className)}>{children}</div>;
}

// ─── data display ───────────────────────────────────────────────────────────

/**
 * A measured value, or an em-dash. There is deliberately no way to render a
 * placeholder that looks like a number.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: string | number | null | undefined;
  hint?: string;
  tone?: "amber" | "cyan" | "fail";
  className?: string;
}) {
  const missing = value === null || value === undefined || value === "";
  const toneClass = tone === "amber" ? "text-a" : tone === "cyan" ? "text-b" : tone === "fail" ? "text-fail" : "text-text";
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <span className="mono-label text-dim">{label}</span>
      <span
        className={cx("tnum font-mono text-xl leading-none", missing ? "text-dim" : toneClass)}
        title={missing ? (hint ?? "not measured") : undefined}
      >
        {missing ? "—" : value}
      </span>
      {hint && !missing ? <span className="text-[11px] text-dim">{hint}</span> : null}
    </div>
  );
}

export function Meter({
  value,
  tone = "amber",
  label,
  right,
  unavailable,
}: {
  /** 0–1, or null when the dimension could not be measured. */
  value: number | null;
  tone?: "amber" | "cyan" | "neutral";
  label?: string;
  right?: ReactNode;
  unavailable?: string;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  const bar = tone === "amber" ? "bg-a" : tone === "cyan" ? "bg-b" : "bg-mid";
  return (
    <div className="flex flex-col gap-1.5">
      {(label || right) && (
        <div className="flex items-baseline justify-between gap-3">
          {label ? <span className="mono-label text-dim">{label}</span> : <span />}
          {right}
        </div>
      )}
      <div className="relative h-1 w-full bg-line" role="presentation">
        {value === null ? (
          <div className="hatch absolute inset-0 opacity-60" title={unavailable ?? "not measured"} />
        ) : (
          <div
            className={cx("absolute inset-y-0 left-0 transition-[width] duration-500 ease-out", bar)}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}

// ─── actions ────────────────────────────────────────────────────────────────

type ButtonTone = "primary" | "ghost" | "danger";

const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: "bg-a text-void border-a hover:bg-[#f2b862] active:translate-y-px",
  ghost: "border-line-strong text-text hover:border-mid hover:bg-surface active:translate-y-px",
  danger: "border-fail/50 text-fail hover:bg-fail-deep active:translate-y-px",
};

const BUTTON_BASE =
  "mono-label inline-flex items-center justify-center gap-2 border px-4 py-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

export function Button({
  children,
  tone = "ghost",
  type = "button",
  onClick,
  disabled,
  className,
  title,
  ...rest
}: {
  children: ReactNode;
  tone?: ButtonTone;
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick" | "className" | "title">) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(BUTTON_BASE, BUTTON_TONES[tone], className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  href,
  tone = "ghost",
  className,
  prefetch,
}: {
  children: ReactNode;
  href: string;
  tone?: ButtonTone;
  className?: string;
  prefetch?: boolean;
}) {
  return (
    <Link href={href} prefetch={prefetch} className={cx(BUTTON_BASE, BUTTON_TONES[tone], className)}>
      {children}
    </Link>
  );
}

// ─── states ─────────────────────────────────────────────────────────────────

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="hatch border border-line px-6 py-14 text-center">
      <div className="mx-auto max-w-md bg-void/80 px-4 py-6">
        <p className="display text-2xl text-text">{title}</p>
        <p className="mt-3 text-sm leading-relaxed text-dim">{body}</p>
        {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

export function NotConfigured({ what, envVar }: { what: string; envVar?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border border-line bg-surface px-3 py-2">
      <Chip tone="muted">Not configured</Chip>
      <span className="text-xs text-dim">
        {what}
        {envVar ? (
          <>
            {" — set "}
            <code className="font-mono text-mid">{envVar}</code>
          </>
        ) : null}
      </span>
    </div>
  );
}

// ─── agent identity ─────────────────────────────────────────────────────────

export function Emblem({
  emblem,
  accent,
  size = "md",
  className,
}: {
  emblem: string;
  accent: "amber" | "cyan" | "neutral";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = {
    sm: "size-7 text-[10px]",
    md: "size-10 text-xs",
    lg: "size-16 text-lg",
  };
  const tones = {
    amber: "border-a-line bg-a-deep text-a",
    cyan: "border-b-line bg-b-deep text-b",
    neutral: "border-line-strong bg-surface text-mid",
  };
  return (
    <span
      aria-hidden
      className={cx(
        "mono-label inline-flex shrink-0 items-center justify-center border tracking-normal",
        sizes[size],
        tones[accent],
        className,
      )}
    >
      {emblem.slice(0, 2).toUpperCase()}
    </span>
  );
}

// ─── formatting ─────────────────────────────────────────────────────────────

export function fmtPct(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
}

export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

export function fmtUsd(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `$${value.toFixed(3)}`;
}

export function fmtNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString("en-US");
}

export function fmtScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

export function fmtTime(epoch: number): string {
  return new Date(epoch).toLocaleTimeString("en-GB", { hour12: false });
}

export function fmtRelative(epoch: number): string {
  const delta = Date.now() - epoch;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
