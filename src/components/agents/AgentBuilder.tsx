"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Check } from "lucide-react";
import type { AgentConfig, ToolSpec } from "@/lib/arena/types";
import type { ProviderStatus } from "@/lib/agents/providers/registry";
import { agentConfigSchema, LIMITS } from "@/lib/agents/schema";
import { deriveProfile } from "@/lib/agents/policies/types";
import { Button, Chip, Emblem, Meter, SectionRule, cx } from "@/components/ui/primitives";

/**
 * Build your agent.
 *
 * The panel on the right is not a score — the agent has never competed, so it
 * has no record and the arena will not invent one. What it shows instead is the
 * *shape* of the configuration: what it has chosen to spend its budget on, and
 * what that implies about how it will behave. Real ratings appear on the
 * profile after real matches.
 */

const PLANNING = [
  { id: "reactive", label: "Reactive", body: "Acts immediately and corrects from results. Fewest steps, most mistakes." },
  { id: "balanced", label: "Balanced", body: "A short plan, then execution, re-planning on surprise." },
  { id: "deep", label: "Deep", body: "Inspects the environment thoroughly before touching it. Slow to start." },
] as const;

const MEMORY = [
  { id: "none", label: "None", body: "Each step sees only the current transcript." },
  { id: "session", label: "Session", body: "Carries the full run history." },
  { id: "persistent", label: "Persistent", body: "Reserved — behaves as session today." },
] as const;

const ACCENTS = [
  { id: "amber", label: "Amber" },
  { id: "cyan", label: "Cyan" },
  { id: "neutral", label: "Neutral" },
] as const;

export function AgentBuilder({
  providers,
  tools,
  initial,
}: {
  providers: ProviderStatus[];
  tools: ToolSpec[];
  initial: AgentConfig;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<AgentConfig>(initial);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const update = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const providerStatus = providers.find((p) => p.id === config.model.provider);
  const willRunDemo = config.model.provider === "scripted" || !providerStatus?.configured;
  const policyProfile = useMemo(() => deriveProfile(config, "builder-preview"), [config]);

  const modelOptions = useMemo(() => {
    const options: { provider: AgentConfig["model"]["provider"]; model: string; label: string; configured: boolean }[] =
      [{ provider: "scripted", model: "policy", label: "Scripted policy", configured: true }];
    for (const provider of providers) {
      for (const model of provider.models) {
        options.push({
          provider: provider.id as AgentConfig["model"]["provider"],
          model: model.id,
          label: model.label,
          configured: provider.configured,
        });
      }
    }
    return options;
  }, [providers]);

  async function save() {
    setPending(true);
    setErrors({});
    setBanner(null);

    const parsed = agentConfigSchema.safeParse(config);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        next[issue.path.join(".") || "root"] = issue.message;
      }
      setErrors(next);
      setBanner("Some fields need attention before this agent can enter the arena.");
      setPending(false);
      return;
    }

    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: parsed.data, visibility: "public" }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        data?: { config: { handle: string } };
        error?: { message: string; details?: { field: string; message: string }[] };
      };
      if (!body.ok || !body.data) {
        if (body.error?.details) {
          setErrors(Object.fromEntries(body.error.details.map((d) => [d.field.replace(/^config\./, ""), d.message])));
        }
        setBanner(body.error?.message ?? "The agent could not be saved.");
        setPending(false);
        return;
      }
      router.push(`/agents/${body.data.config.handle}`);
    } catch {
      setBanner("Could not reach the arena. Check the server is running.");
      setPending(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      {/* ── the console ──────────────────────────────────────────────────── */}
      <div className="space-y-12">
        {banner ? (
          <p className="flex items-start gap-2.5 border border-fail/40 bg-fail-deep px-4 py-3 text-[13px] text-fail">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
            {banner}
          </p>
        ) : null}

        <section>
          <SectionRule label="Identity" />
          <div className="mt-6 space-y-6">
            <Field label="Name" error={errors.name} hint={`${LIMITS.name.min}–${LIMITS.name.max} characters`}>
              <input
                value={config.name}
                onChange={(e) => update("name", e.target.value)}
                maxLength={LIMITS.name.max}
                placeholder="The Archivist"
                className={inputClass(Boolean(errors.name))}
              />
            </Field>

            <Field label="Tagline" error={errors.tagline} hint="One line. What is it for?">
              <input
                value={config.tagline}
                onChange={(e) => update("tagline", e.target.value)}
                maxLength={LIMITS.tagline.max}
                placeholder="Reads everything first. Writes once."
                className={inputClass(Boolean(errors.tagline))}
              />
            </Field>

            <Field label="Description" error={errors.description} hint="Shown on the roster card.">
              <textarea
                value={config.description}
                onChange={(e) => update("description", e.target.value)}
                maxLength={LIMITS.description.max}
                rows={3}
                placeholder="Where it is strong, and where it is not."
                className={inputClass(Boolean(errors.description))}
              />
            </Field>

            <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Emblem" error={errors.emblem} hint="One or two characters.">
                <input
                  value={config.emblem}
                  onChange={(e) => update("emblem", e.target.value.toUpperCase().slice(0, 2))}
                  maxLength={2}
                  className={cx(inputClass(Boolean(errors.emblem)), "w-24 text-center font-mono")}
                />
              </Field>

              <Field label="Accent" hint="Its colour on profile and roster.">
                <div className="flex gap-2">
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent.id}
                      type="button"
                      onClick={() => update("accent", accent.id)}
                      aria-pressed={config.accent === accent.id}
                      className={cx(
                        "mono-label border px-3 py-2 transition-colors",
                        config.accent === accent.id
                          ? "border-line-strong bg-surface text-text"
                          : "border-line text-dim hover:text-mid",
                      )}
                    >
                      {accent.label}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </div>
        </section>

        <section>
          <SectionRule label="Model" />
          <div className="mt-6">
            <div className="grid gap-px bg-line sm:grid-cols-2">
              {modelOptions.map((option) => {
                const selected =
                  config.model.provider === option.provider && config.model.model === option.model;
                return (
                  <button
                    key={`${option.provider}:${option.model}`}
                    type="button"
                    onClick={() =>
                      update("model", {
                        provider: option.provider,
                        model: option.model,
                        label: option.label,
                      })
                    }
                    aria-pressed={selected}
                    className={cx(
                      "flex items-center gap-3 bg-void px-4 py-3 text-left transition-colors hover:bg-base",
                      selected && "bg-base",
                    )}
                  >
                    <span
                      className={cx(
                        "size-2 shrink-0",
                        selected ? "bg-a" : option.configured ? "bg-line-strong" : "bg-line",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cx("block truncate text-[13px]", selected ? "text-text" : "text-mid")}>
                        {option.label}
                      </span>
                      <span className="mono-label block text-dim">{option.provider}</span>
                    </span>
                    {!option.configured ? <Chip tone="muted">Not configured</Chip> : null}
                  </button>
                );
              })}
            </div>

            {willRunDemo ? (
              <p className="mt-4 border border-line bg-base px-4 py-3 text-[12px] leading-relaxed text-dim">
                {config.model.provider === "scripted"
                  ? "A scripted policy makes the decisions. The tools, sandbox and graders are the real ones, and matches are labelled DEMO."
                  : `${providerStatus?.label ?? "This provider"} has no API key, so this agent will run a scripted policy and its matches will be labelled DEMO. Set ${providerStatus?.envVar ?? "the provider key"} to run it live.`}
              </p>
            ) : (
              <p className="mt-4 flex items-center gap-2 border border-b-line bg-b-deep px-4 py-3 text-[12px] text-b">
                <Check size={13} aria-hidden />
                Connected. This agent will run live against {config.model.label}.
              </p>
            )}
          </div>
        </section>

        <section>
          <SectionRule label="System prompt" />
          <div className="mt-6">
            <Field
              label=""
              error={errors.systemPrompt}
              hint={`${config.systemPrompt.length} / ${LIMITS.systemPrompt.max} characters. This is the agent's whole personality.`}
            >
              <textarea
                value={config.systemPrompt}
                onChange={(e) => update("systemPrompt", e.target.value)}
                rows={8}
                maxLength={LIMITS.systemPrompt.max}
                className={cx(inputClass(Boolean(errors.systemPrompt)), "font-mono text-[12px] leading-relaxed")}
              />
            </Field>
          </div>
        </section>

        <section>
          <SectionRule
            label="Tools"
            right={<span className="mono-label text-dim">{config.tools.length} selected</span>}
          />
          {errors.tools ? <p className="mt-3 text-[12px] text-fail">{errors.tools}</p> : null}
          <div className="mt-6 grid gap-px bg-line sm:grid-cols-2">
            {tools.map((tool) => {
              const on = config.tools.includes(tool.name);
              return (
                <button
                  key={tool.name}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() =>
                    update(
                      "tools",
                      on ? config.tools.filter((t) => t !== tool.name) : [...config.tools, tool.name],
                    )
                  }
                  className={cx("flex gap-3 bg-void p-4 text-left transition-colors hover:bg-base", on && "bg-base")}
                >
                  <span
                    className={cx(
                      "mt-0.5 grid size-4 shrink-0 place-items-center border",
                      on ? "border-a bg-a text-void" : "border-line-strong",
                    )}
                    aria-hidden
                  >
                    {on ? <Check size={11} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cx("mono-label block", on ? "text-text" : "text-dim")}>{tool.name}</span>
                    <span className="mt-1.5 block text-[12px] leading-relaxed text-dim">{tool.description}</span>
                    <span className="mono-label mt-2 block text-dim">
                      {tool.permission} · {tool.timeoutMs / 1000}s
                      {tool.cost > 0 ? ` · $${tool.cost.toFixed(3)}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <SectionRule label="Strategy" />
          <div className="mt-6 space-y-8">
            <Choice
              label="Planning"
              options={PLANNING}
              value={config.planning}
              onChange={(v) => update("planning", v)}
            />
            <Choice label="Memory" options={MEMORY} value={config.memory} onChange={(v) => update("memory", v)} />
          </div>
        </section>

        <section>
          <SectionRule label="Limits" />
          <div className="mt-6 space-y-8">
            <Slider
              label="Max steps"
              value={config.maxSteps}
              min={LIMITS.maxSteps.min}
              max={LIMITS.maxSteps.max}
              step={1}
              display={String(config.maxSteps)}
              hint="A tight ceiling forces decisiveness and punishes exploration."
              onChange={(v) => update("maxSteps", v)}
            />
            <Slider
              label="Time limit"
              value={Math.round(config.timeLimitMs / 1000)}
              min={LIMITS.timeLimitSec.min}
              max={LIMITS.timeLimitSec.max}
              step={10}
              display={`${Math.round(config.timeLimitMs / 1000)}s`}
              hint="Wall clock for the whole run."
              onChange={(v) => update("timeLimitMs", v * 1000)}
            />
            <Slider
              label="Budget"
              value={Math.round(config.budgetUsd * 100)}
              min={Math.round(LIMITS.budgetUsd.min * 100)}
              max={Math.round(LIMITS.budgetUsd.max * 100)}
              step={5}
              display={`$${config.budgetUsd.toFixed(2)}`}
              hint="Spent on model tokens and priced tools. Running out ends the run."
              onChange={(v) => update("budgetUsd", v / 100)}
            />
            <Slider
              label="Temperature"
              value={config.temperature === null ? -1 : Math.round(config.temperature * 10)}
              min={-1}
              max={20}
              step={1}
              display={config.temperature === null ? "provider default" : config.temperature.toFixed(1)}
              hint="Left at the far left, the provider's own default is used."
              onChange={(v) => update("temperature", v < 0 ? null : v / 10)}
            />
          </div>
        </section>

        <div className="flex flex-wrap gap-3 border-t border-line pt-8">
          <Button tone="primary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save agent"}
          </Button>
          <Link href="/agents" className="mono-label self-center text-dim transition-colors hover:text-a">
            Cancel
          </Link>
        </div>
      </div>

      {/* ── the readout ──────────────────────────────────────────────────── */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="border border-line bg-base">
          <div className="flex items-start gap-3 border-b border-line p-5">
            <Emblem emblem={config.emblem || "??"} accent={config.accent} size="md" />
            <div className="min-w-0 flex-1">
              <p className="display-tight truncate text-lg text-text">{config.name || "Unnamed agent"}</p>
              <p className="mono-label mt-1 truncate text-dim">{config.model.label}</p>
            </div>
            <Chip tone={willRunDemo ? "muted" : "cyan"}>{willRunDemo ? "Demo" : "Live"}</Chip>
          </div>

          <div className="border-b border-line p-5">
            <p className="mono-label text-dim">Profile</p>
            <p className="mt-2 text-[12px] leading-relaxed text-dim">
              Not a rating. This agent has never competed, so it has no record and the arena will not
              invent one — these bars describe the configuration, not performance.
            </p>
            <div className="mt-5 space-y-4">
              <Attribute
                label="Persistence"
                value={config.maxSteps / LIMITS.maxSteps.max}
                note={`${config.maxSteps} steps before it is cut off`}
              />
              <Attribute
                label="Deliberation"
                value={config.planning === "deep" ? 1 : config.planning === "balanced" ? 0.55 : 0.2}
                note={`${config.planning} planning`}
              />
              <Attribute
                label="Tool reach"
                value={config.tools.length / Math.max(1, tools.length)}
                note={`${config.tools.length} of ${tools.length} tools`}
              />
              <Attribute
                label="Headroom"
                value={config.budgetUsd / LIMITS.budgetUsd.max}
                note={`$${config.budgetUsd.toFixed(2)} budget`}
              />
              <Attribute
                label="Patience"
                value={config.timeLimitMs / (LIMITS.timeLimitSec.max * 1000)}
                note={`${Math.round(config.timeLimitMs / 1000)}s wall clock`}
              />
            </div>
          </div>

          <div className="border-b border-line p-5">
            <p className="mono-label text-dim">Measured attributes</p>
            <div className="mt-4 space-y-3">
              {["Power", "Speed", "Recovery", "Reasoning", "Tool mastery", "Efficiency"].map((label) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="mono-label w-28 shrink-0 text-dim">{label}</span>
                  <span className="flex-1">
                    <Meter value={null} unavailable="unrated — this agent has not competed" />
                  </span>
                  <span className="mono-label w-16 text-right text-dim">Unrated</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-dim">
              These fill in from real matches, on the agent&rsquo;s profile.
            </p>
          </div>

          {willRunDemo ? (
            <div className="p-5">
              <p className="mono-label text-dim">Demo behaviour</p>
              <p className="mt-2 text-[12px] leading-relaxed text-dim">
                Derived from the settings above, so the build genuinely changes how it acts.
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-px bg-line">
                <Mini label="Explore" value={`${policyProfile.explore} extra steps`} />
                <Mini label="Approach" value={policyProfile.careful ? "careful" : "quick"} />
                <Mini label="Verifies" value={policyProfile.verifies ? "yes" : "no"} />
                <Mini label="Recovers" value={`${policyProfile.recovers}x`} />
              </dl>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

// ─── form primitives ────────────────────────────────────────────────────────

function inputClass(hasError: boolean): string {
  return cx(
    "w-full border bg-void px-3 py-2.5 text-sm text-text outline-none transition-colors",
    "placeholder:text-dim/60 focus:border-a",
    hasError ? "border-fail/60" : "border-line-strong",
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      {label ? <span className="mono-label mb-2 block text-dim">{label}</span> : null}
      {children}
      {error ? (
        <span className="mt-1.5 block text-[12px] text-fail">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[11px] text-dim">{hint}</span>
      ) : null}
    </label>
  );
}

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string; body: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="mono-label mb-3 text-dim">{label}</p>
      <div className="grid gap-px bg-line sm:grid-cols-3">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={value === option.id}
            className={cx(
              "bg-void p-4 text-left transition-colors hover:bg-base",
              value === option.id && "bg-base",
            )}
          >
            <span className={cx("mono-label block", value === option.id ? "text-a" : "text-dim")}>
              {option.label}
            </span>
            <span className="mt-2 block text-[12px] leading-relaxed text-dim">{option.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  hint: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="mono-label text-dim">{label}</span>
        <span className="tnum font-mono text-sm text-a">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-3 w-full accent-[#e8a33d]"
      />
      <p className="mt-1.5 text-[11px] text-dim">{hint}</p>
    </div>
  );
}

function Attribute({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="mono-label text-dim">{label}</span>
        <span className="text-[11px] text-dim">{note}</span>
      </div>
      <div className="mt-1.5">
        <Meter value={Math.max(0, Math.min(1, value))} tone="amber" />
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-void px-3 py-2.5">
      <dt className="mono-label text-dim">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[12px] text-mid">{value}</dd>
    </div>
  );
}
