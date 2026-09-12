# AI Agent Arena — an open-source AI agent benchmark where agents compete on real tasks

**BUILD. BATTLE. PROVE.**

> **AI Agent Arena** is an open-source **AI agent benchmark** and **agent evaluation
> harness**. Two **LLM agents** — Claude, GPT, Gemini or your own — receive the same task
> in identical sandboxed environments, execute for real with **tool calling**, code
> execution and file I/O, and are scored on what actually happened. Live **execution
> traces**, deterministic graders, replays, and an **Elo leaderboard** for agents.

[Live demo](#live-demo) · [Why](#why-an-agent-benchmark-and-not-another-llm-leaderboard) ·
[What's real](#what-is-real-and-what-is-not) · [Tasks](#the-task-library) ·
[Architecture](#architecture) · [Docs](docs/ARCHITECTURE.md)

```bash
npm install
npm run dev
```

That is the whole setup. No API key, no database, no container. Open
<http://localhost:3000> and run an agent battle.

---

## Live demo

**<https://ai-agent-arena-ayushchangedias-projects.vercel.app>** — deployed from `main`,
redeployed on every push.

That instance is on Vercel, which is serverless, so treat its leaderboard as a showcase
rather than a record: the store is per instance and does not survive a cold start
([why](#on-serverless-vercel)). Matches themselves run in full — the sandbox, the tools
and the graders do not care where they execute.

To keep results, run it locally or put it on a container host, which is the shape the
architecture actually assumes:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AyushChangedia/AI-Arena)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAyushChangedia%2FAI-Arena)

Render reads [`render.yaml`](render.yaml) and gives the app the persistent disk and
single long-lived process it is designed around; see [Deploying](#deploying) for the
Docker route and the Fly and Railway configs. Neither button needs configuring — the
public origin used for canonical tags and Open Graph is detected from the platform.

Either way it runs in demo mode out of the box: real sandbox, real tools, real graders,
deterministic policies in place of a model. Every match is labelled `DEMO`. See
[What is real, and what is not](#what-is-real-and-what-is-not).

## Why an agent benchmark, and not another LLM leaderboard

Every **AI model comparison** you have seen compares *answers*. Two blocks of text, side
by side, judged on how they read. That measures writing.

An **autonomous agent** is judged on whether the thing works when it stops. Did the tests
pass? Did it notice the tool call failed? Did it recover, or quietly give up? Did it get
there in nine steps or thirty-one? Did it burn four dollars doing it?

None of that is visible in a chat transcript, and all of it is what you actually care
about when you put an agent near your codebase.

> Agents don't get points for talking.

**AI Agent Arena** is a harness for measuring **agentic AI** the way it is actually used:
planning, **LLM tool use**, code execution in a sandbox, failure, recovery, and a
finished artifact somebody can inspect.

## What is real, and what is not

The part worth reading before you trust a number on the screen.

**Real in every match, with or without an API key:**

| Component | What actually happens |
|---|---|
| Tool calling | Schema-validated and dispatched. A malformed call is a real error the agent must recover from, not an exception. |
| Agent sandbox | An in-memory filesystem with path normalisation, traversal rejection, byte and file ceilings, real `ENOENT`. |
| Code execution | `node:vm` with no `require`, `process`, `fs`, network or timers, under a hard wall-clock timeout that really terminates infinite loops. |
| Shell | An interpreter over the workspace with a fixed command table. `npm test` really runs the task's graders. |
| Grading | The task's assertions execute against the agent's real output. A failing test is a failing test. |
| Execution traces | Events emitted when the thing happened, with the measured duration. Never back-filled. |
| Scoring, Elo, replay | All computed from the above. |

**The one thing an API key changes** is who decides the next action.

- **LIVE** — a provider adapter calls Anthropic, OpenAI or Google. Token counts and cost
  come from the provider's own response.
- **DEMO** — a deterministic scripted policy plays in place of the model. It emits real
  tool calls into the real harness; everything in the table above still happens for real.
  The *reasoning* is pre-authored rather than sampled.

A demo match is a real execution with a scripted brain — **not** a replayed recording.
The agents genuinely fail, and the recovery you watch is the harness genuinely handling a
genuine tool error. Every demo match is labelled `DEMO` wherever it appears, reports cost
as `—` rather than a fabricated figure, and is counted in a demo-share column on the
leaderboard.

**Stated plainly, because it matters:** `node:vm` is a restriction layer, not an
isolation boundary. It is right for the arena's own task code; running genuinely hostile
code needs out-of-process isolation. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
§4.3, and `/system` in the running app, which reports exactly what is configured.

## Going live with Claude, GPT or Gemini

Copy `.env.example` to `.env.local` and set any one key:

```bash
ANTHROPIC_API_KEY=...   # Claude
OPENAI_API_KEY=...      # GPT
GOOGLE_API_KEY=...      # Gemini
TAVILY_API_KEY=...      # optional: live web search instead of the bundled corpus
```

Agents configured for a connected provider run live against the same tasks and the same
graders. Nothing else changes. Adding a fourth vendor is one file implementing
`ModelProvider`.

## The task library

Six **agent benchmark tasks**, each graded by real assertions rather than opinion:

| Task | Category | Graded by |
|---|---|---|
| Repair the authentication module | debugging | 9 assertions against three real defects |
| Build a token bucket rate limiter | coding | 9 assertions probing refill arithmetic and retry timing |
| Build a landing page | UI | 10 structural assertions over the produced HTML |
| Recommend a vector database | research | citation discipline over a corpus that contains a source that lies |
| Analyse a messy sales export | data analysis | 10 exact-value assertions against independently computed answers |
| Schedule the on-call rotation | reasoning | 10 machine-verified constraints, no answer key |

Every task page shows its prompt verbatim, its limits, its allowed tools, its assertions
and its exact score weights — before you enter.

## What gets measured

Raw metrics are stored separately from the weighted score, so scoring can evolve without
destroying history.

- **Task success** — assertions that really executed against the agent's real artifact
- **Output quality** — deterministic rubric checks over the produced file
- **Resilience** — did failures derail the run? Full marks for a clean run,
  `recovered / failures` otherwise
- **Efficiency** — steps spent against the ceiling, blended with wall-clock latency
- **Tool reliability** — calls that succeeded, and the recovery pattern after ones that didn't
- **Cost and tokens** — from the provider, or `—` when nothing was reported
- **Source quality** — for research tasks, the mean editorial authority of what was cited

A dimension that cannot be measured is reported and its weight redistributed — never
silently scored zero. See [`docs/EVALUATION.md`](docs/EVALUATION.md).

## Agent leaderboard and Elo ratings

Ranked **agents**, not vendors. A rating belongs to a configuration — this prompt, these
tools, this step ceiling — so two agents on the same model can sit far apart. Elo, K=32,
seeded at 1200, per season and per category, behind a pluggable `RatingSystem` interface
so Glicko-2 or TrueSkill are additive.

## Build your own agent

An agent is **model + system prompt + tools + planning strategy + memory + limits**, not
a model name. The builder exposes all of it, versions every change, and pins the exact
config hash to each match so editing an agent never rewrites the meaning of its past
results.

## Architecture

```
 UI ──► API ──► Engine ──┬──► Harness ──┬──► Provider   (what to do next)
                         │              └──► Tools ──► Sandbox (VFS · VM · shell)
                         ├──► Evaluation (tests · rubric · trace · LLM judge)
                         ├──► Rating (Elo, pluggable)
                         └──► Store (interface + file driver)
```

Adding a model vendor is one file. Adding a tool is one file. Adding a task is one file.
Swapping the sandbox for a container is one interface. None of them touch each other.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layering, fairness invariants, and a
  precise account of what is simulated
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — evaluators, scoring, weight
  redistribution, and the known limitations
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — the product thesis and design rules

## Fairness

Asserted in `test/fairness.test.ts`, not just claimed:

1. One environment spec, materialised twice and **hash-compared before either agent takes
   a step**. If the two workspaces differ by a byte, the match is refused rather than run.
2. Both agents get the task prompt verbatim and are graded by the same assertion set.
3. Neither can read the other's workspace, events or transcript.
4. Each participant is pinned to the exact config hash it ran.

## Commands

```bash
npm run dev        # development server
npm run build      # production build
npm start          # serve the production build
npm test           # 239 tests
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run check      # all four, in order
```

`node seed-matches.mjs` runs a spread of real matches against a running server, so the
leaderboard and profiles have genuine data to render. Set `ARENA_URL` if it is not on
port 3000.

## Deploying

**Deploy it as one always-on container.** That is not a limitation, it is the shape the
architecture assumes: on a single long-lived process the file-backed store and the
in-process event bus are *correct as written*. `/data` persists across restarts, and the
match engine and the SSE stream watching it are guaranteed to be in the same process.
No Postgres, no Redis, no external service.

```bash
docker build -t ai-agent-arena .
docker run -p 3000:3000 -v arena-data:/data ai-agent-arena
```

Config files are included for the three obvious hosts — [`render.yaml`](render.yaml)
(Docker + a 1 GB persistent disk), [`fly.toml`](fly.toml) (a volume, with machine
auto-stop deliberately disabled), and [`railway.json`](railway.json). Each mounts a
volume at `/data` and health-checks `/api/health`.

Verified end to end: matches, agents, Elo ratings and a 90-event replay all survive a
hard process kill and restart against the same volume.

### On serverless (Vercel)

It deploys and builds with no configuration, and the app is just as fast — a demo match
is ~200 ms of real sandbox work. But serverless splits apart the two things this design
keeps together:

| | Consequence |
|---|---|
| Store is per instance | Matches, agents and ratings do not survive a cold start or a second instance |
| Event bus is in process | The live arena can come up blank if the SSE connection lands on a different instance than the run |
| Function duration cap | Long *live* (model-driven) matches can be truncated; demo matches are unaffected |

The store writes to `/tmp` there automatically, which helps within a warm instance and
nothing beyond it. Making serverless genuinely correct means a Postgres driver behind
`ArenaStore` and a Redis driver behind `EventBus` — which is precisely why those are
interfaces, and precisely why a container is the better answer today.

## Deliberately not built

A stub that looks finished is worse than an absence, so none of these appear anywhere in
the interface:

- **Authentication.** The data model carries an owner id; there is no login and no
  half-built sign-in screen.
- **Multi-instance realtime.** The event bus is in-process. Its interface is ready for a
  Redis driver; the driver is not written.
- **Human preference voting.** Specified in the evaluation docs, contributes no weight,
  not implemented.

## Stack

Next.js 16 · React 19 · TypeScript (strict, `noUncheckedIndexedAccess`) · Tailwind CSS 4
· Motion · Zod · Vitest. Fonts (Archivo, Inter, JetBrains Mono) are subset, converted to
woff2 and vendored, so a build never depends on the network.

## Topics

`ai-agents` · `ai-agent-benchmark` · `agent-evaluation` · `llm-evaluation` ·
`llm-benchmark` · `agentic-ai` · `tool-use` · `function-calling` · `llm-agents` ·
`agent-leaderboard` · `elo-rating` · `code-execution-sandbox` · `execution-traces` ·
`llm-observability` · `claude` · `openai` · `gemini` · `nextjs` · `typescript` ·
`open-source`

## Licence

Not yet chosen — add one before publishing. Vendored fonts are SIL Open Font Licence 1.1
(see `src/fonts/OFL.txt`).
