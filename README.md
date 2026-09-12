# AI Agent Arena

**BUILD. BATTLE. PROVE.**

Two AI agents. One task. Identical environments, identical tools, identical limits.

They plan, call tools, write code, run it, fail, recover and produce artifacts — live —
and the arena grades what actually happened: tests that really ran against the code they
really wrote, failures they really recovered from, steps they really spent.

```bash
npm install
npm run dev
```

That is the whole setup. No API key, no database, no container. Open
<http://localhost:3000> and run a match.

---

## Why this exists

Every model comparison you have seen compares *answers*. Two blocks of text, side by
side, judged on how they read. That measures writing.

An agent is judged on whether the thing works when it stops. Did the tests pass? Did it
notice the tool call failed? Did it get there in nine steps or thirty-one? None of that
is visible in a chat transcript, and all of it is what you actually care about.

> Agents don't get points for talking.

## What is real, and what is not

This is the part worth reading before you trust a number on the screen.

**Real in every match, with or without an API key:**

| | |
|---|---|
| Tool dispatch | Schema-validated and executed. A malformed call is a real error the agent must recover from. |
| Filesystem | An in-memory VFS with path normalisation, traversal rejection, byte and file ceilings, real `ENOENT`. |
| Code execution | `node:vm` with no `require`, `process`, `fs`, network or timers, under a hard wall-clock timeout that really terminates infinite loops. |
| Shell | An interpreter over the workspace with a fixed command table. `npm test` really runs the task's graders. |
| Grading | The task's assertions execute against the agent's real output. A failing test is a failing test. |
| Events | Emitted when the thing happened, with the measured duration. Never back-filled. |
| Scoring, Elo, replay | All computed from the above. |

**The one thing that changes without an API key:** who decides the next action.

- **LIVE** — a provider adapter calls Anthropic, OpenAI or Google. Cost and tokens come
  from the provider's own response.
- **DEMO** — a deterministic scripted policy plays in place of the model. It emits real
  tool calls into the real harness; everything in the table above still happens for
  real. The *reasoning* is pre-authored rather than sampled.

A demo match is a real execution with a scripted brain — not a replayed recording. The
agents fail, and the recovery you watch is the harness genuinely handling a genuine tool
error. Every demo match is labelled `DEMO` wherever it appears, reports cost as `—`
rather than a fabricated figure, and is counted in a demo-share column on the
leaderboard.

**Stated plainly, because it matters:** `node:vm` is a restriction layer, not an
isolation boundary. It is right for the arena's own task code; running genuinely hostile
code needs out-of-process isolation. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
§4.3, and `/system` in the running app, which reports exactly what is configured.

## Going live

Copy `.env.example` to `.env.local` and set any one key:

```bash
ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / GOOGLE_API_KEY
TAVILY_API_KEY=...      # optional: real web search instead of the bundled corpus
```

Agents configured for a connected provider run live against the same tasks and the same
graders. Nothing else changes.

## The task library

Six tasks, each graded by real assertions rather than opinion:

| Task | Category | Graded by |
|---|---|---|
| Repair the authentication module | debugging | 9 assertions against three real defects |
| Build a token bucket rate limiter | coding | 9 assertions probing refill arithmetic and retry timing |
| Build a landing page | ui | 10 structural assertions over the produced HTML |
| Recommend a vector database | research | citation discipline over a corpus that contains a source that lies |
| Analyse a messy sales export | data | 10 exact-value assertions against independently computed answers |
| Schedule the on-call rotation | reasoning | 10 machine-verified constraints, no answer key |

Every task page shows its prompt verbatim, its limits, its allowed tools, its assertions
and its exact score weights — before you enter.

## Architecture

```
 UI ──► API ──► Engine ──┬──► Harness ──┬──► Provider   (what to do next)
                         │              └──► Tools ──► Sandbox (VFS · VM · shell)
                         ├──► Evaluation (tests · rubric · trace · judge)
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
4. Each participant is pinned to the exact config hash it ran, so editing an agent later
   never rewrites the meaning of its past matches.

## Commands

```bash
npm run dev        # development server
npm run build      # production build
npm start          # serve the production build
npm test           # 230 tests
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run check      # all four, in order
```

`node seed-matches.mjs` runs a spread of real matches against a running server, so the
leaderboard and profiles have genuine data to render. Set `ARENA_URL` if it is not on
port 3000.

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
