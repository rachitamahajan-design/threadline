# The AI workflow harness

How Threadline runs model-backed work without trusting the model — and what you
must not break if you fork this repo.

Every AI workflow here is **closed loop**: it runs under a budget governor,
retries silently and aimed, passes deterministic gates, ends in one of four
named outcomes, and leaves a structured record — even if the process dies
mid-run. Model selection, budgets, retry policy, gates, prompts and logging are
all **config, not code**.

```
            agents.json / config/prompts.json          (the control plane)
                          │
   ┌──────────────────────┼─────────────────────────┐
   │                      ▼                         │
   │   recordRun ──▶ Budget.for(kind) ──▶ retry ──▶ chatJson ──▶ provider A
   │   (runlog.ts)   (harness.ts)      (harness.ts) (model.ts)  └─▶ provider B (silent failover)
   │       │                                            │
   │       │            deterministic gates ◀── output ─┘
   │       │            (grounding.ts) + entailment gate (entail.ts)
   │       ▼
   │   runs table (SQLite) + data/logs/*.log (JSONL, rotated)
   └── outcome: shipped | partial | deadline | failed ──▶ UI (outcome + retry only)
```



## File map


| File                       | Role                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/reasons.ts`       | The structured vocabulary: `Outcome`, `FailureCode`, `Reason`, error classification. Imports nothing; everything imports it.                           |
| `src/lib/config.ts`        | Typed loader for `agents.json` (budgets, retry, gates, models, pricing, logging). Code defaults everywhere — a missing config degrades, never crashes. |
| `src/lib/harness.ts`       | `Budget` (the governor), `retry` (silent, aimed), `decideExit`, gates plumbing, `StepRecord`.                                                          |
| `src/lib/model.ts`         | The network boundary for meeting *text*. Provider resolution, per-purpose overrides, token/cost capture, silent provider failover.
| `src/lib/pyai.ts`          | The second sanctioned boundary: meeting *audio* to PyAI speech surfaces (Hear stream, Recap, diarization jobs). Nothing else ships audio.                    |
| `src/lib/runlog.ts`        | Failure invariance: run records written at start, finalized at exit. `recordRun` wraps every workflow.                                                 |
| `src/lib/log.ts`           | JSON Lines log files with size-based rotation. Never throws, never logs meeting content.                                                               |
| `src/lib/prompts.ts`       |                                                                                                                                                        |
| `src/lib/grounding.ts`     | \                                                                                                                                                      |
| `src/pipeline/entail.ts`   | The model-assisted entailment gate — blocking/advisory/off per config.                                                                                 |
| `src/pipeline/grounded.ts` | The compose loop: model → parse → validate → aimed retry → prune.                                                                                      |
| `src/pipeline/handoff.ts`  | Orchestrators (`ensureNotes`, `runHandoff`, `runCrossHandoff`) — all wrapped in `recordRun`, all fail closed.
| `src/pipeline/diarize.ts`  | Speaker identification (kind `diarize`): recordRun-wrapped; `diarize_runs` is UI chip state only, vocabulary aligned to outcomes.                                          |




## The four outcomes

Every run ends in exactly one of (`OUTCOMES` in `reasons.ts`):


| Outcome    | Meaning                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------- |
| `shipped`  | Everything produced and verified.                                                         |
| `partial`  | Something shipped, but steps failed, were blocked, or content was pruned (`needsReview`). |
| `deadline` | The budget governor stopped the run — time **or** units exhausted.                        |
| `failed`   | A core step died; nothing usable shipped.                                                 |


There is no fifth value. If you need a new terminal state, think hard — the
whole point is that dashboards, tests and the UI can branch on a closed set.

## Structured reasons — no free strings

Every "why" is a `Reason = { code: FailureCode, detail?: string }`.

- **Add a failure mode** by adding a code to `FAILURE_CODES` in `reasons.ts`
and a human label to `LABELS`. Never inline a new string.
- **Throw** `new CodedError("grounding-blocked", detail)` when you know the
code; `reasonFrom(e)` classifies everything else (HTTP status, timeout
message, schema prefix → the right code; unknown → `crash`).
- **Two renderers, one rule**:
  - `describeReason(r)` → prefers the raw `detail`. For logs, run records and
  repair prompts. **Never for the UI.**
  - `publicReason(r)` → the code's human label only ("the model host returned
  an error"). The only function allowed to feed user-visible `error` fields.



## Config reference



### `agents.json`

```jsonc
"models": {
  "chat": {
    "provider": "pyai",                          // preferred when its key exists
    "model": { "pyai": "pyai-think", "openai": "gpt-4o-mini" },
    "purposes": { "notes": { "temperature": 0.1 } }  // per-purpose overrides
  },
  "pricing": { "pyai-think": { "in": 0.0005, "out": 0.0015 } }  // USD per 1k tokens
},
"budgets": {
  "workflows": {                                  // Budget.for(kind) reads this
    "process-meeting": { "units": 60, "ms": 180000 },
    "notes":           { "units": 12, "ms": 150000 },
    "handoff":         { "units": 12, "ms": 150000 },
    "cross-handoff":   { "units": 16, "ms": 180000 },
    "ask":             { "units": 3,  "ms": 15000 },
    "needle":          { "units": 4,  "ms": 20000 },
    "chat":            { "units": 4,  "ms": 30000 }
  }
},
"retry":   { "max_attempts": 3, "base_delay_ms": 400 },
"gates":   { "entailment": "blocking" },          // blocking | advisory | off
"logging": { "dir": "data/logs", "file": "threadline.log",
             "max_bytes": 5242880, "max_files": 5, "level": "info", "console": true }
```



### `config/prompts.json`

All prompt **text** lives here, with `{{var}}` placeholders and a `version` per
template. `src/lib/prompts.ts` interpolates and stamps every output with
`<template>@v<version>+r<groundingRulesVersion>`. **Bump the version whenever
you change text in a way that could move output** — that stamp is how a
regression gets traced to a prompt diff instead of an archaeology project.
When a prompt instruction and a validator disagree, the validator wins and the
prompt is what gets rewritten.

### Env overrides (`.env`)

Env always beats config, so a shell can override per-run: `MODEL_PROVIDER`,
`PYAI_CHAT_MODEL`, `MODEL_TIMEOUT_MS`, `LOG_LEVEL`, `LOG_DIR`, `LOG_TO_FILE=0`,
`ENTAIL_SPOTCHECK` (legacy; config `gates.entailment` is the real switch).

## The budget governor

`Budget` is one class, two dimensions: API **units** and wall-clock **ms**.
`Budget.for(kind)` sizes it from `budgets.workflows`. `budget.check()` returns
a structured reason (`budget-exhausted` / `deadline-exceeded`) or `null`, and
is consulted **before every step and every retry attempt** — an exhausted run
records `skipped` steps instead of spending. Either exhaustion exits the run as
`deadline`.

Spend units with `budget.spendUnits(1)` after each model call. If you add a
workflow that calls the model, it takes a `Budget` — no unmetered calls.

Future work - We should have usage calls after every api call/ to recalculate  
remaining budget

## Silent, aimed retries

`retry(name, budget, fn, opts)` in `harness.ts`:

- **Silent** — attempts are invisible to the user; the record keeps the count.
- **Aimed** — `fn(attempt, lastError)` receives the previous failure's exact
text. The compose loop feeds validator output back verbatim (`REPAIR`
template), so a retry is a correction, not a re-roll of the dice.
- **Structured** — the step record's `reason` is `reasonFrom(lastError)`.
- **Bounded** — max attempts and backoff base come from `retry` config;
`opts.retryable` short-circuits errors that can never heal (a 400 or a dead
key fails once, immediately).



## *The model adapter (*`model.ts`*)*

*The only* `fetch` *that meeting content passes through. Resolution order for
provider and model name: **env → config → code default**. Each call records
token usage priced from config;* `usageCursor()`*/*`usageSince()` *let the run
logger attribute tokens and cost to a run.*

***Silent provider failover**: if the chosen provider throws a* `ModelError`
*(404, dead key, timeout, 5xx) and the other provider's key exists, the call is
retried there once. The user sees an answer; the usage log and run record name
the provider that actually produced it. Only both hosts failing surfaces — and
even that is a recorded outcome with a retry button, never a crash.*

## Failure invariance (`runlog.ts`)

**No run exits without leaving a structured record.** The mechanism is write
order, not discipline:

1. `beginRun` INSERTs the row the moment a run starts — already stamped
  `failed` with a `crash` reason.
2. `finish` (called on success *and* in the catch) UPDATEs it with the truth:
  outcome, steps, failure, tokens, cost, duration.
3. A `kill -9` mid-run therefore leaves an honest record. Nothing to remember,
  nothing to forget.

`recordRun(db, {kind, meetingId, args}, fn, summarize)` wraps a workflow in
that guarantee: it builds the config budget, exposes `runId` to the body,
maps the result onto an outcome, and **rethrows only after finalizing**.
`args` stores what a retry needs (handoff id, question, refine text) — that is
what powers `POST /api/run/retry`.

Records live in the `runs` table (`data/opengranola.db`):

```
kind, meeting_id, started_at, ended_at, outcome, failure (JSON Reason),
steps (JSON StepRecord[]), args (JSON), units_spent, tokens_in, tokens_out, cost_usd
```

Read them via `GET /api/runs?meeting_id=…` (user-safe projection) or SQL.

## Gates

Two layers, different trust models:

1. **Deterministic validators** (`grounding.ts`) — code, not model. Citations
  must exist, every claim carries a source, numbers/dates/quotes must be
   verbatim in the cited text, owners are whitelisted, theme labels assert
   nothing. These fail closed: an unsupported line is pruned, never softened.
2. ~~**The entailment gate** (~~`entail.ts`~~) — one cheap model call asking, per~~
  ~~leaf, "do the cited segments support this claim?" Catches paraphrase drift
   the substring guards can't see ("Let's launch this product" becoming "wants
   to launch as soon as possible"). Mode is config:~~
  - `blocking` ~~(default) — unsupported leaves are pruned before display~~
  - `advisory` ~~— marked~~ `lowConfidence`~~, shown with a quiet flag~~
  - `off`
   ~~One asymmetry is deliberate: **if the checker itself fails, nothing is
   deleted** — output ships marked needs-review. Unverified is not the same as
   wrong, and a dead model must never gain delete authority.~~



## Log files (`log.ts`)

Structured JSON Lines to `data/logs/threadline.log`, rotated by size
(`threadline.log` → `.1` → … → dropped). Disk is hard-bounded at
`(max_files + 1) × max_bytes`. Three rules:

1. **Logging never crashes the app.** Every write is wrapped; a full disk
  degrades to silence.
2. **No meeting content.** Ids, counts, codes, durations only — the log must
  be safe to paste into a bug report.
3. **Writes are synchronous.** A crash gets to leave its own last words;
  volume is a few lines per meeting, so the cost is irrelevant.

Events: `run.start`, `run.finish`, `model.failover`, `model.call` (debug
only), `api.error`, `process.unhandledRejection`, `process.uncaughtException`.

## The user boundary

What the user sees: **outputs, plain-language failure states with a Retry
button, and content-trust markers** (the low-confidence banner, dropped-line
counts, per-line receipts, the opt-in "why?" on handoff cards).

What the user never sees: failure codes, `detail` strings, HTTP bodies, step
logs, stack traces, run dashboards, retry narration. Server 500s return a
generic message and log the stack. Run records reach the browser only through
the `forUi` projection in `server/index.ts`. If you add a surface, route any
failure text through `publicReason()` — nothing else.

And the process itself never dies for a workflow failure: orchestrators fail
closed (return `{ error }`), and `unhandledRejection`/`uncaughtException`
handlers log instead of exiting. A dead server is the one state with no retry
button.

## Recipes

**Swap or add a model** — edit `agents.json → models.chat`. Per-purpose:
`models.chat.purposes["<purpose>"] = { model, temperature }`. Add pricing to
`models.pricing` or the cost column reads 0.

**Resize a budget / change retry policy / flip a gate** — one edit in
`agents.json`. No rebuild.

**Edit a prompt** — edit the text in `config/prompts.json`; bump its
`version`. New variables need a matching `build()` change in
`src/lib/prompts.ts`.

**Add a workflow kind**

1. Add it to `WORKFLOW_KINDS` in `config.ts` and give it a budget in
  `agents.json → budgets.workflows`.
2. Wrap the entry point in `recordRun(db, { kind, meetingId, args }, fn,
  summarize)`—`summarize` maps your result to an outcome and steps.
3. Fail closed: catch model errors inside, return `{ error: publicReason(r) }`.
4. Teach `POST /api/run/retry` how to re-dispatch it from `args`.

**Add a failure mode** — new code in `FAILURE_CODES` + label in `LABELS`
(`reasons.ts`); throw `CodedError` where it happens.

**Add a validator rule** — new rule name in the `Rule` union
(`grounding.ts`), a check function, wire it into `validateNotes` /
`validateSourcedItems`, and add it to `LEAF_KILLERS` in `notes-outline.ts` if
its failure should delete the line rather than flag it.

## Invariants — the list to re-read before merging a fork change

1. Every workflow ends in one of the four outcomes and leaves a run record,
  even on crash. (`beginRun` before work, `finish` in the catch.)
2. No model call outside `model.ts`, and none unmetered by a `Budget`.
3. Retries are silent and aimed; the user sees outcomes, never attempts.
4. Validators outrank prompts. Failing output is pruned or blocked — never
  shipped softened, never "approximately" anything.
5. A checker failure never deletes content; it marks needs-review.
6. User-facing text goes through `publicReason`; details stay in records/logs.
7. Logs contain no meeting content and cannot throw.
8. A workflow failure never kills the server.



## Tests

`npm test` — the suite runs with `MODEL_PROVIDER=mock` (no keys, no network).
The harness-specific suites: `test/closed-loop.test.ts` (outcomes, budget
governor, aimed retries, run-record invariance, entailment gate, provider
failover, fail-closed orchestration) and `test/log.test.ts` (rotation bounds,
crash-safety of the logger). `npx tsc --noEmit` before committing — the
structured-reason typing is load-bearing: it is what makes "no free strings"
enforceable at compile time.