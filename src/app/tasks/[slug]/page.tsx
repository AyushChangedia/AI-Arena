import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink, Chip, SectionRule, Shell, cx } from "@/components/ui/primitives";
import { allTasks, getTaskDefinition } from "@/lib/tasks";
import { getToolSpec } from "@/lib/tools/registry";
import { dimensionLabel, dimensionNote, weightsFor } from "@/lib/eval/scoring";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return allTasks().map((task) => ({ slug: task.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const def = getTaskDefinition(slug);
  if (!def) return { title: "Task not found" };
  return { title: def.task.title, description: def.task.brief };
}

export default async function TaskDetailPage({ params }: Props) {
  const { slug } = await params;
  const def = getTaskDefinition(slug);
  if (!def) notFound();

  const { task } = def;
  const weights = weightsFor(task);

  return (
    <Shell className="py-10">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="muted">{task.category}</Chip>
        <Chip tone={task.difficulty === "hard" || task.difficulty === "expert" ? "amber" : "muted"}>
          {task.difficulty}
        </Chip>
        {task.evaluation.weightsOverridden ? (
          <Chip tone="muted" title="This task overrides its category's default weights.">
            Custom weights
          </Chip>
        ) : null}
      </div>

      <h1 className="display mt-6 text-[clamp(30px,5vw,52px)] text-bright">{task.title}</h1>
      <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-mid">{task.brief}</p>

      <div className="mt-8">
        <ButtonLink href="/arena" tone="primary">
          Run this task in the arena
        </ButtonLink>
      </div>

      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-12">
          <section>
            <SectionRule label="The prompt, verbatim" />
            <pre className="mt-6 overflow-x-auto border border-line bg-base p-5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-mid">
              {task.prompt}
            </pre>
            <p className="mt-3 text-[11px] text-dim">
              Both agents receive exactly this text. Neither gets a hint the other does not.
            </p>
          </section>

          {task.seedFiles.length > 0 ? (
            <section>
              <SectionRule label="Starting workspace" />
              <ul className="mt-6 divide-y divide-line border-y border-line">
                {task.seedFiles.map((file) => (
                  <li key={file.path} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                    <span className="font-mono text-[12px] text-mid">{file.path}</span>
                    <span className="tnum font-mono text-[11px] text-dim">{file.content.length} chars</span>
                    {file.note ? <span className="text-[12px] text-dim">{file.note}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-dim">
                Materialised twice from one spec and hash-compared before either agent takes a step.
              </p>
            </section>
          ) : null}

          <section>
            <SectionRule label="How it is graded" />
            {def.tests.length > 0 ? (
              <>
                <p className="mono-label mt-6 text-dim">
                  {def.tests.length} authoritative assertion{def.tests.length === 1 ? "" : "s"}
                </p>
                <ul className="mt-3 divide-y divide-line border-y border-line">
                  {def.tests.map((test) => (
                    <li key={test.id} className="py-2.5 text-[13px] text-mid">
                      {test.name}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[11px] text-dim">
                  These run against the agent&rsquo;s real workspace and execute its real code. They are
                  authoritative — no other evaluator can overrule a failing assertion.
                </p>
              </>
            ) : (
              <p className="mt-6 text-[13px] text-dim">
                This task has no pass/fail assertions. It is graded by deterministic rubric checks
                over the artifact, plus trace measurements.
              </p>
            )}

            {def.rubric.length > 0 ? (
              <>
                <p className="mono-label mt-8 text-dim">{def.rubric.length} rubric checks</p>
                <ul className="mt-3 divide-y divide-line border-y border-line">
                  {def.rubric.map((check) => (
                    <li key={check.id} className="flex items-baseline justify-between gap-4 py-2.5">
                      <span className="text-[13px] text-mid">{check.name}</span>
                      <span className="tnum mono-label shrink-0 text-dim">weight {check.weight}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </div>

        <aside className="space-y-10">
          <section>
            <SectionRule label="Limits" />
            <dl className="mt-5 grid grid-cols-3 gap-px bg-line">
              <Fact label="Steps" value={String(task.limits.stepLimit)} />
              <Fact label="Time" value={`${Math.round(task.limits.timeLimitMs / 1000)}s`} />
              <Fact label="Budget" value={`$${task.limits.budgetUsd.toFixed(2)}`} />
            </dl>
            <p className="mt-3 text-[11px] text-dim">
              An agent runs under the lower of its own limits and these.
            </p>
          </section>

          <section>
            <SectionRule label="Tools allowed" />
            <ul className="mt-5 space-y-3">
              {task.toolsAllowed.map((name) => {
                const spec = getToolSpec(name);
                return (
                  <li key={name} className="border border-line bg-base p-3">
                    <p className="mono-label text-text">{name}</p>
                    {spec ? (
                      <p className="mt-1.5 text-[12px] leading-relaxed text-dim">{spec.description}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          <section>
            <SectionRule label="Score weights" />
            <ul className="mt-5 divide-y divide-line border-y border-line">
              {Object.entries(weights)
                .sort(([, x], [, y]) => y - x)
                .map(([key, weight]) => (
                  <li key={key} className="py-2.5">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-[13px] text-mid">{dimensionLabel(key)}</span>
                      <span className="tnum font-mono text-[13px] text-a">{(weight * 100).toFixed(0)}%</span>
                    </div>
                    {dimensionNote(key) ? (
                      <p className="mt-1 text-[11px] text-dim">{dimensionNote(key)}</p>
                    ) : null}
                  </li>
                ))}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-dim">
              A dimension that cannot be measured — no provider for the judge, no failures to recover
              from — is skipped and its weight redistributed across the rest, visibly.
            </p>
          </section>

          <section>
            <SectionRule label="Success conditions" />
            <ul className="mt-5 space-y-2">
              {task.successConditions.map((condition) => (
                <li key={condition} className="flex gap-2.5 text-[13px] leading-relaxed text-dim">
                  <span className="mt-1.5 size-1 shrink-0 bg-a" aria-hidden />
                  {condition}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      <p className="mt-14 border-t border-line pt-6 text-[11px] text-dim">
        <Link href="/tasks" className="text-mid underline">
          All tasks
        </Link>
      </p>
    </Shell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={cx("bg-void px-3 py-3")}>
      <dt className="mono-label text-dim">{label}</dt>
      <dd className="tnum mt-1 font-mono text-[13px] text-mid">{value}</dd>
    </div>
  );
}
