# AI Agent Arena — Architecture

> **Design rule that governs every decision below:** the Arena never renders a
> number or a state it did not actually observe. If something is simulated, the
> product says so in the UI, not just in a comment.

---

## 1. The one-paragraph version

An **Agent** (model + system prompt + tools + planning policy + limits) is handed a
**Task**. A **Harness** runs that agent as a real tool-calling loop against a real
**Environment** (an in-memory filesystem plus a whitelisted virtual shell and a
`node:vm` code executor). Every decision the agent makes emits an **Event** onto a
per-match bus, which the browser consumes over SSE. When the loop terminates, a set of
**Evaluators** grade whatever artifacts actually exist in the environment — coding
tasks are graded by running real assertions against the agent's real code. The graded
**Metrics** are stored raw and separately from the weighted **Score**, so the scoring
function can change later without destroying history. Scores decide the match, the
match updates **Elo ratings**, and the full event trace is persisted as a **Replay**.

## 2. Layer map

Each layer knows only about the layer directly beneath it. The arrows are the only
permitted dependencies.

```
 UI (app/, components/)
   │  fetch + EventSource only. No domain logic.
   ▼
 API (app/api/**)             zod-validated boundary
   │
   ▼
 Engine (lib/arena/engine.ts) match lifecycle, fairness, persistence hooks
   │
   ├──► Harness (lib/arena/harness.ts)   the agent loop
   │      ├──► Provider (lib/agents/providers/*)   decides the next action
   │      └──► Tools (lib/tools/*)                 performs the action
   │              └──► Sandbox (lib/sandbox/*)     VFS · VM · virtual shell
   │
   ├──► Evaluation (lib/eval/*)  tests · rubric · judge · scoring
   ├──► Rating (lib/rating/*)    Elo today, pluggable tomorrow
   └──► Store (lib/store/*)      persistence interface + file driver
```

Cross-cutting: `lib/arena/events.ts` (the bus) is written to by the harness and read by
the API. It is the only channel between a running match and the outside world.

## 3. Why these boundaries

**Provider ≠ Agent.** A provider answers one question: *given this conversation and
this tool catalogue, what is the next action?* It returns either `text` or `tool_call`.
It knows nothing about matches, scoring, or the arena. Adding a fourth model vendor is
one file implementing `ModelProvider`; nothing else changes.

**Tools ≠ Sandbox.** A tool is a validated, costed, timed *capability description*
(`name`, `schema`, `permission`, `timeoutMs`, `cost`, `execute`). The sandbox is the
*mechanism* it runs on. `shell.exec` is a tool; the virtual shell that parses and runs
`cat build/index.html` is sandbox machinery. This split is what lets the whole tool
catalogue stay identical across demo and live matches — which is what makes the two
comparable at all.

**Metrics ≠ Score.** `Evaluation` persists a flat bag of raw measurements
(`tests.passed = 7`, `tools.failed = 2`, `latency.totalMs = 9140`). `Score` is a pure
function of metrics × task weights, computed on read. Re-weighting a task category does
not require re-running a single match.

**Rating ≠ Store.** `RatingSystem` takes two ratings and an outcome and returns two new
ratings. It touches no database. Swapping Elo for Glicko-2 is a new implementation of a
three-method interface.

## 4. Execution model: what is real, precisely

This is the section to read if you are evaluating whether the product is honest.

### 4.1 Always real, in every match — demo and live alike

| Component | What actually happens |
|---|---|
| Tool dispatch | Arguments are zod-validated, rejected on schema failure, and dispatched to a real executor. Malformed calls produce real tool errors the agent must recover from. |
| Filesystem | A real in-memory VFS: path normalisation, traversal rejection, byte/file-count ceilings, real `ENOENT`. |
| Code execution | Real `node:vm` evaluation with a hard wall-clock timeout and a context that has no `require`, `process`, `fs`, or network. |
| Shell | A real parser + interpreter over the VFS for a fixed command whitelist. `npm test` really runs the task's graders. |
| Test grading | Task assertions really execute against the agent's real output. A failing test is a failing test. |
| Events | Emitted at the moment the thing happened, with the measured duration. Never back-filled, never interpolated. |
| Limits | Steps, wall-clock, and budget are enforced by the harness. Exceeding one really terminates the run. |
| Scoring | Computed from the metrics above. |
| Elo | Computed from the score. |

### 4.2 The single difference between demo and live

Only one thing changes: **who decides the next action.**

- **LIVE match** — a `ModelProvider` adapter calls Anthropic / OpenAI / Google over
  HTTPS. Token usage and cost come back from the provider's own response.
- **DEMO match** — a `ScriptedProvider` plays a deterministic, seeded policy in place of
  the model. It emits genuine tool calls into the genuine harness. Everything in §4.1
  still happens for real; the *reasoning* is pre-authored rather than sampled.

A demo match is therefore a real execution with a scripted brain — **not** a replayed
recording. The agent can and does fail: policies contain deliberate wrong turns, and the
recovery you watch is the harness really handling a real tool error.

The UI labels this everywhere a match appears: a `DEMO` chip on match cards, headers,
result screens and replays, plus an explicit "scripted policy · real execution" note on
the match detail page. Demo cost is reported as `—`, never as a fabricated dollar
figure, and demo matches are excluded from token accounting.

### 4.3 What is *not* real, stated plainly

- **`node:vm` is a restriction layer, not a security boundary.** It removes host
  bindings and enforces a timeout, which is appropriate for the arena's own task code
  and for agent-written code under a cooperative threat model. It is *not* sufficient
  isolation for genuinely hostile code — a determined escape via shared intrinsics is a
  known class of attack against in-process JS sandboxes. Production deployment with
  untrusted agents must run the executor out-of-process (container, microVM, or V8
  isolate). The `CodeExecutor` interface in `lib/sandbox/vm.ts` is the seam for that
  swap, and `docs/EVALUATION.md` restates this next to the grading claims.
- **`shell.exec` is not a host shell.** It is an interpreter over a whitelist
  (`ls cat echo mkdir rm cp mv grep wc head tail pwd cd touch node npm`). There is no
  path from it to the host OS — by construction, not by filtering.
- **`web.search` / `web.fetch`** run against a bundled offline corpus unless a search
  provider is configured. Results carry `source: "offline-corpus"` and the UI shows an
  `OFFLINE CORPUS` badge on the tool card. Nothing pretends to be the live web.
- **LLM-judge dimensions** are skipped, not guessed, when no provider is configured.
  The affected weight is redistributed across available evaluators and the match detail
  page reports the redistribution.

## 5. Match lifecycle

```
POST /api/matches                 create   → status: pending
POST /api/matches/:id/start       run
   │
   ├─ snapshot both agent configs (immutable AgentVersion per participant)
   ├─ build ONE canonical environment spec from the task + seed
   ├─ materialise TWO independent VFS instances from that identical spec
   ├─ run both harnesses concurrently, each with its own event stream + bus topic
   ├─ on termination: evaluate each execution against the same evaluator set
   ├─ score → compare → decide winner (or draw within epsilon)
   ├─ apply rating deltas
   └─ persist Match + Execution + Events + Artifacts + Evaluation + Score
GET  /api/matches/:id/events      SSE, replays the buffer then streams live
GET  /api/matches/:id/replay      the persisted trace, for scrubbing
```

### Fairness invariants (enforced, and unit-tested in `test/fairness.test.ts`)

1. Both participants receive a **structurally identical environment** built from the
   same `(task, seed)` pair — verified by hashing the materialised VFS of each side
   before the first step and asserting equality.
2. Both receive the **same task prompt** and the **same tool catalogue**, intersected
   with each agent's own allowed-tool list. If the agents' tool lists differ, that is a
   property of the *agent*, shown in the pre-match panel — not a hidden advantage.
3. Neither execution can read the other's VFS, events, or transcript: the bus is topic
   -scoped per execution and VFS instances share no references.
4. Limits are per-agent and declared up-front on the agent card.

## 6. Realtime

`EventBus` is an in-process pub/sub with a bounded per-topic ring buffer. A subscriber
receives the buffered backlog first, then live events, so a browser that opens the arena
mid-match sees the whole story. The SSE route sends a heartbeat comment every 15s to
keep intermediaries from closing the stream, and closes cleanly on abort.

Single-process only, deliberately. The `EventBus` interface is three methods
(`publish`, `subscribe`, `history`); a Redis or Postgres-LISTEN driver drops in behind
it for multi-instance deployment without touching the harness or the UI.

## 7. Persistence

`ArenaStore` is the full persistence surface (~20 methods over the entities in §8). The
shipped driver, `FileStore`, keeps an in-memory index and writes JSON snapshots to
`.data/` with a debounced, atomic (write-temp-then-rename) flush. It degrades to
pure-memory on a read-only filesystem rather than crashing.

That choice is deliberate for a product whose first run must work with zero setup: no
container, no migration, no connection string. The interface is shaped so a
Postgres/Drizzle driver is a drop-in — every method is already a single logical query,
and no caller reaches around it.

### Deployment shape

The store and the bus share an assumption: **one long-lived process**. Under that
assumption both are correct rather than provisional — `/data` persists across restarts,
and a running match and the SSE stream watching it are guaranteed to be in the same
process. The shipped `Dockerfile`, `render.yaml`, `fly.toml` and `railway.json` all
describe exactly that: a single container with a volume at `/data` and a health check
at `/api/health`.

Serverless breaks the assumption in two places at once — per-instance memory and
per-invocation lifetime — so a deployment there loses state on cold start and can drop a
live stream that lands on the wrong instance. Two drivers fix it (Postgres behind
`ArenaStore`, Redis behind `EventBus`) and neither is written, because a container needs
neither.

## 8. Data model

```
User ─┬─< Agent ──< AgentVersion            (config snapshots; matches pin a version)
      └─< Match

Task ──< Match ──< MatchParticipant ──1 Execution ──┬──< ExecutionEvent
                                                    ├──< ToolCall
                                                    ├──< Artifact
                                                    └──1 Evaluation ──< Metric
                                                                      └──1 Score
Season ──< Match
Season ──< LeaderboardEntry  (agent × season × category → Rating + aggregates)
```

`AgentVersion` matters: editing an agent must not rewrite the meaning of its past
matches. Every participant row pins the exact config hash it ran.

## 9. Frontend architecture

- **Server components by default.** Client components only where there is genuine
  interactivity: the live arena, the replay scrubber, the builder, filter controls.
- **One realtime hook**, `useMatchStream`, owns the `EventSource`. Everything else
  derives from its reduced state, so there is exactly one socket per arena view.
- **Event rendering is virtualised** above a threshold; a long trace renders a windowed
  slice, not 4,000 DOM nodes.
- **Motion is state-driven.** Animations are keyed to real transitions (a tool started,
  a score resolved). There is no ambient animation loop and no decorative particle
  system. `prefers-reduced-motion` collapses every transition to an instant state
  change via a single `useReducedMotion` gate.

## 10. Security posture

- All model output is untrusted input. Tool arguments are zod-parsed before dispatch;
  a parse failure is a tool error returned to the agent, never a thrown exception.
- Path handling normalises and rejects `..` traversal and absolute escapes.
- No host process execution anywhere in the codebase. There is no `child_process`
  import; `test/security.test.ts` asserts that as a regression guard.
- Provider keys are read from `process.env` inside server-only modules and are never
  serialised into a payload the client can see. `/api/providers` returns
  `configured: boolean` and nothing else.
- Per-execution ceilings: wall clock, step count, budget, VFS bytes, VFS file count,
  single-file size, tool timeout, and output truncation.
- API writes are rate-limited per client with a fixed-window limiter.

## 11. Extension points (the test of whether the layering worked)

| To add… | Touch only |
|---|---|
| A model vendor | `lib/agents/providers/<vendor>.ts` + one registry line |
| A tool | `lib/tools/<tool>.ts` + one registry line |
| A task | `lib/tasks/definitions/<task>.ts` + one index line |
| An evaluator | `lib/eval/<name>.ts` implementing `Evaluator` |
| A ranking system | `lib/rating/<name>.ts` implementing `RatingSystem` |
| A database | `lib/store/<driver>.ts` implementing `ArenaStore` |
| Real container sandboxing | `lib/sandbox/vm.ts` implementing `CodeExecutor` |

None of these require touching the engine, the UI, or each other.
