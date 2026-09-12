# AI Agent Arena — Evaluation & Scoring

The evaluation system answers one question: *given two execution traces, which agent
did the task better, and can we show our working?*

Three commitments shape it:

1. **Deterministic signals outrank model opinion.** If a task has tests, the tests are
   authoritative. An LLM judge never overrules a failing assertion.
2. **Raw metrics are stored separately from the score.** Weights are presentation.
   Changing them re-derives history instead of destroying it.
3. **An unavailable evaluator is reported, never guessed.** No configured provider means
   the judge dimension is skipped and its weight is redistributed — visibly.

---

## 1. Evaluator interface

```ts
interface Evaluator {
  readonly id: string;
  readonly dimensions: readonly MetricKey[];
  readonly deterministic: boolean;
  evaluate(ctx: EvaluationContext): Promise<EvaluatorResult>;
}

interface EvaluatorResult {
  status: "ok" | "unavailable" | "error";
  metrics: Metric[];           // raw measurements
  notes: string[];             // shown verbatim in match detail
}
```

`EvaluationContext` carries the finished execution: the final VFS, every artifact, the
full event trace, tool-call statistics, timings, and token/cost accounting when the
provider reported it.

## 2. The evaluators

### `AutomatedTestsEvaluator` — deterministic, authoritative

Runs the task's `tests[]` against the final environment. A test is a real function:
read a file from the VFS, execute agent code in the VM sandbox, assert on the result.

```
metrics: tests.total · tests.passed · tests.failed · tests.passRate
```

A test that throws is a failure attributed to the agent's code, never swallowed. A test
that times out is a failure with `reason: "timeout"`. Test output is captured and shown
per assertion on the match page, so a loss is inspectable line by line.

### `RubricEvaluator` — deterministic

Programmatic checks that are not pass/fail assertions: does the required artifact
exist, does the report cite at least N distinct sources, does the HTML contain the
required landmarks, is the JSON parseable and shaped correctly, is the recommendation
section non-empty. Each check has a weight and contributes a 0–1 sub-score.

```
metrics: rubric.checksTotal · rubric.checksPassed · rubric.score
```

### `TraceEvaluator` — deterministic

Measures the execution itself rather than its output. This is where the arena's
distinctive dimensions live, because they are invisible in a chat transcript.

```
metrics:
  steps.used · steps.limit
  tools.called · tools.failed · tools.reliability   ( = 1 − failed/called )
  recovery.failures · recovery.recovered · recovery.rate · resilience.score
  latency.totalMs · latency.meanToolMs
  cost.usd · tokens.in · tokens.out                 ( null when unreported )
  efficiency.score
```

**Recovery** is defined precisely: a failure is *recovered* when the agent makes at
least one subsequent successful tool call on the same logical target (same tool, same
primary argument) after a failing one. Consecutive failures against one target collapse
into a single failure, so an agent is neither punished for retrying nor rewarded for
retrying a lot. That definition is implemented in `lib/eval/trace.ts` and unit-tested.
It is not a vibe.

**Resilience** is what the score actually weighs, and it is a different question:
*did failures derail this run?* It is `1.0` when nothing failed, and
`recovered / failures` otherwise.

The distinction matters because the obvious modelling — weigh `recovery.rate` and treat
"no failures" as unmeasurable — is wrong in a way that took a real match to expose. It
redistributes the weight away from an agent that did everything right, while an agent
that broke something and then fixed it scores 100% on the same dimension. That makes
failing *profitable*. Zero failures is not missing data; it is the best possible answer
to the question, and it scores as such. The raw failure and recovery counts stay
visible beside it.

**Efficiency** is `1 − clamp(stepsUsed / stepsLimit, 0, 1)` blended with a latency term
normalised against the task's `timeLimitMs`. An agent that solves a task in 6 of 30
allowed steps scores high; one that grinds to step 29 scores low, even if both pass.

### `LlmJudgeEvaluator` — non-deterministic, optional, bounded

Only runs when a provider is configured **and** the task declares qualitative
dimensions. It is given the task, the rubric, and the artifacts — never the identity of
the agent, never its model name, never the other agent's work. It scores narrow
qualitative dimensions only: code quality, reasoning quality, report clarity.

It **cannot** move `tests.passRate`. If tests fail, the task has failed, whatever the
judge thinks of the prose.

With no provider configured it returns `status: "unavailable"`, and the match page shows:

> `QUALITY (LLM JUDGE) — NOT CONFIGURED · 15% weight redistributed`

### `HybridEvaluator` — the composer

Runs the applicable evaluators, merges their metrics into one flat bag, and hands it to
the scorer. Evaluator errors are contained: one failing evaluator marks its own
dimensions unavailable and the match still completes and scores.

### `HumanVoteEvaluator` — specified, not implemented

Defined here for completeness. It is not built, contributes no weight, and appears
nowhere in the product.

## 3. Scoring

```
score = 100 × Σ(weightᵢ × normalisedMetricᵢ) / Σ(weightᵢ)
```

The denominator is the sum of weights of *available* dimensions only — that is the
redistribution mechanism, and it means an unavailable judge cannot silently depress a
score toward zero.

Every metric is normalised to 0–1 by a declared normaliser (`ratio`, `inverseRatio`,
`threshold`, `passthrough`) before weighting, so dimensions with different units stay
comparable.

### Weights are per task category

Coding:

| Dimension | Weight |
|---|---|
| `tests.passRate` | 40% |
| `rubric.score` | 20% |
| `quality.code` *(judge)* | 15% |
| `efficiency.score` | 10% |
| `resilience.score` | 10% |
| `cost.usd` *(inverse)* | 5% |

Research:

| Dimension | Weight |
|---|---|
| `rubric.score` *(accuracy + citations)* | 30% |
| `sources.quality` | 25% |
| `rubric.coverage` | 20% |
| `quality.reasoning` *(judge)* | 15% |
| `efficiency.score` | 10% |

Debugging weights `tests.passRate` to 50% and `resilience.score` to 15%; data-analysis
weights correctness of computed values to 45%. Each task may override its category
defaults, and the override is displayed on the task page — so you always know what you
are being graded on before you enter.

## 4. Deciding the match

1. Higher total score wins.
2. Scores within **0.5 points** are a **draw**. A match decided by a rounding artefact
   is not a result.
3. If both agents fail every test, the match is a **double failure**: no winner, and
   both ratings move toward the loser side. Two agents failing badly does not crown one
   of them.

## 5. "Why the winner won"

Generated from the metric delta, not from prose. The generator takes both metric bags,
computes deltas, filters to dimensions that (a) differ materially and (b) carry real
weight in this task, ranks by weighted contribution to the score gap, and renders the
top factors:

```
THE ARCHITECT WON BECAUSE:
  +28.6%  test pass rate      7/7 vs 5/7
  +21.0%  resilience          3 of 3 recovered vs 1 of 3
  −18.2%  tool calls          18 vs 22
  −2.41s  mean tool latency
```

Every figure traces to a stored metric. The generator has no capacity to invent a
number: it can only subtract two measurements. If nothing differs materially it says
so, rather than manufacturing a narrative.

## 6. Rating

Elo, `K = 32`, seeded at `1200`, updated after every rated match.

```
expectedA = 1 / (1 + 10^((ratingB − ratingA) / 400))
ratingA'  = ratingA + K × (scoreA − expectedA)     scoreA ∈ {1, 0.5, 0}
```

Ratings are per `(agent, season, category)`. An agent therefore has an overall rating
and a coding rating that can diverge — which is the useful signal.

`RatingSystem` is an interface; Glicko-2 and TrueSkill are additive, and the stored
match history is sufficient to recompute any of them from scratch.

## 7. Known limitations

Stated because a benchmark that hides its weaknesses is not a benchmark.

- **Task count is small.** A handful of tasks cannot characterise a general agent. The
  ratings are meaningful *within this task set* and should not be read as a general
  capability claim.
- **The VM sandbox is a restriction layer, not an isolation boundary.** It has no host
  bindings and a hard timeout, which is right for cooperative code. Hostile code needs
  out-of-process isolation. See `docs/ARCHITECTURE.md` §4.3.
- **Offline corpus ≠ the web.** Research tasks graded against a bundled corpus measure
  synthesis and citation discipline, not live retrieval. Results are badged accordingly.
- **The judge is a model.** It is bounded to qualitative dimensions and blinded to agent
  identity, but it is not objective. That is why it never exceeds 15% and never touches
  test outcomes.
- **Scripted policies are authored.** A demo match measures the harness honestly, but a
  scripted agent's *decisions* were written by a human, so demo results say nothing
  about model capability. They are excluded from nothing — they are simply labelled, and
  the leaderboard shows a `DEMO` share column so you can see how much of a rating is
  scripted.
