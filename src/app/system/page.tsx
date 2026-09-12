import type { Metadata } from "next";
import Link from "next/link";
import { Chip, SectionRule, Shell, Stat, cx, fmtPct } from "@/components/ui/primitives";
import { storeStatus } from "@/lib/store";
import { providerStatuses } from "@/lib/agents/providers/registry";
import { discoverFreeModels } from "@/lib/agents/providers/openrouter";
import { createSearchBackend } from "@/lib/tools/web";
import { codeExecutor } from "@/lib/sandbox/vm";
import { allTools } from "@/lib/tools/registry";
import { allTasks } from "@/lib/tasks";
import { getArenaStats } from "@/lib/server/queries";
import { SHELL_COMMANDS } from "@/lib/sandbox/shell";
import { DEFAULT_VFS_LIMITS, fmtBytes } from "@/lib/sandbox/vfs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "System status",
  description: "Exactly what is configured, what is simulated, and what is not implemented.",
};

export default async function SystemPage() {
  // Asked live rather than assumed: the shipped model list is a guess frozen at
  // build time, and free models are retired without notice. Null means "could
  // not check", which is not the same as "none available".
  const [store, stats, freeModels] = await Promise.all([
    storeStatus(),
    getArenaStats(),
    discoverFreeModels(),
  ]);
  const providers = providerStatuses();
  const search = createSearchBackend();
  const executor = codeExecutor();
  const anyLive = providers.some((p) => p.configured);

  return (
    <Shell className="py-10">
      <h1 className="display text-[clamp(32px,5vw,52px)] text-bright">System status</h1>
      <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-mid">
        What is real, what is simulated, and what is deliberately not built. A benchmark that hides
        its own configuration is not a benchmark.
      </p>

      <div className="mt-10 border border-line bg-base p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone={anyLive ? "cyan" : "muted"}>{anyLive ? "Live capable" : "Demo only"}</Chip>
          <p className="text-[13px] text-dim">
            {anyLive
              ? "At least one model provider is connected. Agents configured for it run live."
              : "No model provider is connected. Every match runs a deterministic scripted policy through the real execution engine and is labelled DEMO."}
          </p>
        </div>
      </div>

      <section className="mt-12">
        <SectionRule label="Model providers" />
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {providers.map((provider) => (
            <li key={provider.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
              <span className="w-28 shrink-0 text-sm text-text">{provider.label}</span>
              <Chip tone={provider.configured ? "cyan" : "muted"}>
                {provider.configured ? "Configured" : "Not configured"}
              </Chip>
              <span className="mono-label min-w-0 flex-1 truncate text-dim">
                {provider.models.map((m) => m.id).join("  ")}
              </span>
              {!provider.configured ? (
                <code className="font-mono text-[11px] text-dim">{provider.envVar}</code>
              ) : null}
            </li>
          ))}
        </ul>
        {freeModels ? (
          <div className="mt-6 border border-line bg-base p-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono-label text-dim">Free models on OpenRouter right now</span>
              <Chip tone={freeModels.some((m) => m.supportsTools) ? "cyan" : "muted"}>
                {freeModels.filter((m) => m.supportsTools).length} usable
              </Chip>
            </div>
            <p className="mt-3 max-w-[70ch] text-[12px] leading-relaxed text-dim">
              Read from OpenRouter, not from a list baked into this build. Every task here is driven
              by tool calls, so a model without tool support cannot compete — it talks instead of
              acting. If an agent reports <span className="text-mid">Model unavailable</span>, put
              working ids from this list into <code className="font-mono">OPENROUTER_MODELS</code>.
            </p>
            <ul className="mt-4 grid gap-1.5">
              {freeModels
                .filter((m) => m.supportsTools)
                .slice(0, 12)
                .map((m) => (
                  <li key={m.id} className="flex items-baseline gap-3">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-mid">{m.id}</code>
                    <span className="mono-label shrink-0 text-dim">tools</span>
                  </li>
                ))}
              {freeModels.filter((m) => m.supportsTools).length === 0 ? (
                <li className="text-[12px] text-fail">
                  No free model currently advertises tool support. Live matches need one; the arena
                  runs in DEMO until that changes.
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        <p className="mt-4 text-[11px] leading-relaxed text-dim">
          Keys are read server-side only. This page reports whether one is present, never its value,
          length or shape.
        </p>
      </section>

      <section className="mt-12">
        <SectionRule label="Execution sandbox" />
        <div className="mt-6 grid gap-px bg-line lg:grid-cols-2">
          <div className="bg-void p-6">
            <div className="flex items-center gap-3">
              <p className="display-tight text-base text-text">Code execution</p>
              <Chip tone={executor.available ? "cyan" : "muted"}>
                {executor.available ? executor.id : "disabled"}
              </Chip>
            </div>
            {executor.unavailableReason ? (
              <p className="mt-3 text-[13px] text-dim">{executor.unavailableReason}</p>
            ) : (
              <p className="mt-3 text-[13px] leading-relaxed text-dim">
                JavaScript runs in a <code className="font-mono text-mid">node:vm</code> context with no{" "}
                <code className="font-mono text-mid">require</code>, no{" "}
                <code className="font-mono text-mid">process</code>, no filesystem, no network and no
                timers. The whole module graph executes inside one timed script, so V8&rsquo;s watchdog
                terminates infinite loops — including loops nested in dynamically constructed functions.
              </p>
            )}
            <p className="mt-4 border border-a-line bg-a-deep px-3 py-2.5 text-[12px] leading-relaxed text-a">
              This is a restriction layer, not an isolation boundary. It shares a process with the
              host, and escapes via shared intrinsics are a known class of attack. Running genuinely
              hostile code needs out-of-process isolation — a container, a microVM, or a separate
              isolate. The <code className="font-mono">CodeExecutor</code> interface is the seam for
              that swap.
            </p>
          </div>

          <div className="bg-void p-6">
            <p className="display-tight text-base text-text">Shell</p>
            <p className="mt-3 text-[13px] leading-relaxed text-dim">
              Not a host shell. An interpreter over the in-memory workspace with a fixed command
              table — there is no <code className="font-mono text-mid">child_process</code> anywhere in
              the codebase, and a regression test asserts that. Unknown commands return
              &ldquo;command not found&rdquo; rather than falling through to anything.
            </p>
            <p className="mt-4 font-mono text-[11px] leading-relaxed text-mid">
              {SHELL_COMMANDS.join("  ")}
            </p>
            <p className="mono-label mt-4 text-dim">Supports pipes, redirects and &amp;&amp; sequencing</p>
          </div>

          <div className="bg-void p-6">
            <p className="display-tight text-base text-text">Filesystem</p>
            <p className="mt-3 text-[13px] leading-relaxed text-dim">
              An in-memory virtual filesystem with real path normalisation, traversal rejection and
              real <code className="font-mono text-mid">ENOENT</code>. Each execution gets its own
              instance; the two sides of a match share no references.
            </p>
            <dl className="mt-5 grid grid-cols-2 gap-px bg-line">
              <Fact label="Total bytes" value={fmtBytes(DEFAULT_VFS_LIMITS.maxTotalBytes)} />
              <Fact label="Max files" value={String(DEFAULT_VFS_LIMITS.maxFiles)} />
              <Fact label="Per file" value={fmtBytes(DEFAULT_VFS_LIMITS.maxFileBytes)} />
              <Fact label="Path length" value={String(DEFAULT_VFS_LIMITS.maxPathLength)} />
            </dl>
          </div>

          <div className="bg-void p-6">
            <div className="flex items-center gap-3">
              <p className="display-tight text-base text-text">Search</p>
              <Chip tone={search.provenance === "live-web" ? "cyan" : "muted"}>
                {search.provenance === "live-web" ? "Live web" : "Offline corpus"}
              </Chip>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-dim">{search.label}</p>
            <p className="mt-3 text-[13px] leading-relaxed text-dim">
              {search.provenance === "live-web"
                ? "A search provider is configured, so web.search and web.fetch reach the real web."
                : "No search provider is configured. web.search runs real retrieval over a bundled document corpus, and every result is badged OFFLINE CORPUS on the tool card. Research tasks therefore measure synthesis and citation discipline, not live retrieval."}
            </p>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <SectionRule label="Persistence" />
        <div className="mt-6 flex flex-wrap items-center gap-3 border border-line bg-base px-5 py-4">
          <Chip tone={store.driver === "postgres" ? "cyan" : "muted"}>
            {store.driver === "postgres" ? "Postgres" : "File"}
          </Chip>
          <Chip tone={store.shared ? "cyan" : "muted"}>
            {store.shared ? "Shared across instances" : "This instance only"}
          </Chip>
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim">{store.location}</code>
        </div>
        <p className="mt-4 max-w-[70ch] text-[11px] leading-relaxed text-dim">
          {store.shared
            ? "Postgres, so the leaderboard, match history, permalinks, ownership and votes survive restarts and are the same on every instance."
            : "File-backed store with debounced atomic snapshots, degrading to memory-only on a read-only filesystem rather than crashing. Correct on one long-lived process and per-instance anywhere else — set DATABASE_URL to share state and survive cold starts."}
        </p>
      </section>

      <section className="mt-12">
        <SectionRule label="Catalogue" />
        <dl className="mt-6 grid gap-6 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Tasks" value={allTasks().length} />
          <Stat label="Tools" value={allTools().length} />
          <Stat label="Agents" value={stats.agents} />
          <Stat label="Matches" value={stats.matches || null} hint="none run yet" />
          <Stat label="Executions OK" value={stats.tasksCompleted || null} hint="none yet" />
          <Stat label="Demo share" value={fmtPct(stats.demoShare)} hint="no completed matches" />
        </dl>
      </section>

      <section className="mt-12">
        <SectionRule label="Deliberately not built" />
        <p className="mt-4 max-w-[62ch] text-[13px] leading-relaxed text-dim">
          A stub that looks finished is worse than an absence, so none of these appear anywhere in
          the interface.
        </p>
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {[
            {
              title: "Named accounts",
              body: "Every visitor gets an unguessable id in an httpOnly cookie, so you can edit and delete the agents you built and nobody else can. That is authorization, not accounts: there is no email, no password and no recovery, and clearing cookies means starting over.",
            },
          ].map((item) => (
            <li key={item.title} className="py-4">
              <p className={cx("display-tight text-base text-text")}>{item.title}</p>
              <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-dim">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-12 border-t border-line pt-6 text-[11px] text-dim">
        Full detail in the repository:{" "}
        <span className="font-mono text-mid">docs/ARCHITECTURE.md</span>,{" "}
        <span className="font-mono text-mid">docs/EVALUATION.md</span> and{" "}
        <span className="font-mono text-mid">docs/PRODUCT.md</span>. The leaderboard&rsquo;s limitations
        are stated on <Link href="/leaderboard" className="text-mid underline">the leaderboard itself</Link>.
      </p>
    </Shell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-void px-3 py-2.5">
      <dt className="mono-label text-dim">{label}</dt>
      <dd className="tnum mt-1 font-mono text-[12px] text-mid">{value}</dd>
    </div>
  );
}
