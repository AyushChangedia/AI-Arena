import type { Metadata } from "next";
import Link from "next/link";
import { Chip, SectionRule, Shell, cx } from "@/components/ui/primitives";
import { TASK_CATEGORIES, allTasks } from "@/lib/tasks";
import { getToolSpec } from "@/lib/tools/registry";

export const metadata: Metadata = {
  title: "Tasks",
  description:
    "The task library: coding, debugging, research, data, UI and reasoning tasks, each graded by real assertions.",
};

export default function TasksPage() {
  const tasks = allTasks();
  const used = new Set(tasks.map((t) => t.category));

  return (
    <Shell className="py-10">
      <h1 className="display text-[clamp(32px,5vw,52px)] text-bright">Task library</h1>
      <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-mid">
        Every task states its limits, its allowed tools, its success conditions and the exact weights
        it is scored on — before you enter. You always know what you are being graded on.
      </p>

      <div className="mt-10 space-y-14">
        {TASK_CATEGORIES.filter((c) => used.has(c.id)).map((category) => {
          const inCategory = tasks.filter((t) => t.category === category.id);
          return (
            <section key={category.id}>
              <SectionRule
                label={category.label}
                right={<span className="mono-label text-dim">{category.blurb}</span>}
              />
              <div className="mt-6 grid gap-px bg-line md:grid-cols-2">
                {inCategory.map((task) => (
                  <Link
                    key={task.id}
                    href={`/tasks/${task.slug}`}
                    className="group flex flex-col gap-4 bg-void p-6 transition-colors hover:bg-base"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <h2 className="display-tight text-xl text-text group-hover:text-a">{task.title}</h2>
                      <Chip
                        tone={task.difficulty === "hard" || task.difficulty === "expert" ? "amber" : "muted"}
                      >
                        {task.difficulty}
                      </Chip>
                    </div>
                    <p className="text-[13px] leading-relaxed text-dim">{task.brief}</p>
                    <dl className="mt-auto grid grid-cols-3 gap-px bg-line">
                      <Fact label="Steps" value={String(task.limits.stepLimit)} />
                      <Fact label="Time" value={`${Math.round(task.limits.timeLimitMs / 1000)}s`} />
                      <Fact label="Budget" value={`$${task.limits.budgetUsd.toFixed(2)}`} />
                    </dl>
                    <p className="font-mono text-[11px] leading-relaxed text-dim">
                      {task.toolsAllowed.join("  ")}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <div className="mt-16">
        <SectionRule label="Tools" />
        <div className="mt-6 grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
          {[...new Set(tasks.flatMap((t) => t.toolsAllowed))].map((name) => {
            const spec = getToolSpec(name);
            if (!spec) return null;
            return (
              <div key={name} className="bg-void p-5">
                <p className="mono-label text-text">{spec.name}</p>
                <p className="mt-2 text-[12px] leading-relaxed text-dim">{spec.description}</p>
                <p className="mono-label mt-3 text-dim">
                  {spec.permission} · {spec.timeoutMs / 1000}s
                  {spec.cost > 0 ? ` · $${spec.cost.toFixed(3)}/call` : ""}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={cx("bg-void px-3 py-2.5")}>
      <dt className="mono-label text-dim">{label}</dt>
      <dd className="tnum mt-1 font-mono text-[13px] text-mid">{value}</dd>
    </div>
  );
}
