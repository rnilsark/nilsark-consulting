# Plan: Star clusters — LLM for judgment, TypeScript for procedure

Persistent working doc for the next architecture track: splitting the monolithic `entrepreneur`
agent into a **domain cluster** (a deterministic TS orchestrator + small judgment agents), and the
conceptual/visual model that follows. Survives context resets — **update as you go.** Companion to
`docs/interactive-finance-plan.md` and `docs/cfo-architecture.md`.

## Status

- **Phase:** DESIGN ONLY — nothing built. Conceptual model agreed; no code, no migration started.
- **Last updated:** 2026-06-20
- **Motivation:** a quiet daily `entrepreneur` run costs ~$1.14 / 48 turns doing **procedure** (list,
  dedup, re-fetch, date math, hashing) at LLM prices. The agent is a god-object: orchestration +
  state I/O + classification + matching + prose, all in one `claude -p`. LLMs are for judgment;
  `if`-statements are not.

## The principle

**LLM for judgment over messy/ambiguous input. Deterministic TypeScript for procedure, I/O, and
comparison.** This is not a new pattern — it's the harness's *own* pattern, applied to the one agent
that smuggled procedure inside the LLM.

The harness already runs this split everywhere else:
- **Deterministic TS adapters (no LLM):** `src/adapters/chat.ts`, `inbox.ts`, `health.ts`,
  `schedule.ts`, `src/outbox.ts` — polling, routing, gating, delivery, healthcheck.
- **LLM agents (`claude -p` via the worker):** `triage`, `chat`, `planner`, `inbox`, `entrepreneur`.
- The chat path is `chat.ts (poll/route) → triage (judge) → chat (judge)`. The inbox path is
  `inbox.ts (poll/dedup) → inbox (judge) → entrepreneur:intake (judge)`. Finance just needs the same.

## The conceptual model: entry clusters vs domain clusters

There is a layer **between CORE and the leaf agents**: domains, each a cluster.

- **CORE** — the runtime/dispatcher. The one universal hub (the constellation's center).
- **Entry clusters** — route *inward* to domains. `chat` (the **human** door, via `chat.ts`/`triage`)
  and `schedule`/`CORE` (the **time** door, via cron). Their job is "what does the input want," then
  dispatch. They are not capabilities themselves; their edges reach *into* domain clusters.
- **Domain clusters** — self-contained capability subsystems: a deterministic orchestrator hub + its
  judgment satellites. **Finance** (`finance.ts` + classify/reconcile/summarize) and **calendar**
  (`planner`) are domains.

Two kinds of "star": **orchestrator-stars** (deterministic adapters — local centers of gravity) and
**LLM-stars** (the judgment agents orbiting them). `chat`/`schedule` are entry hubs; finance/calendar
are domain hubs. Splitting `entrepreneur` makes finance a literal sub-constellation.

## The entrepreneur split

| Stays an LLM agent (judgment) | Moves to TS (procedure) |
|---|---|
| Classify a document (faktura/kvitto/skattekonto/unknown) from a PDF or photo | State I/O: download/parse `state.md`, collision guard (`headRevisionId`), upload |
| Extract fields from a non-uniform invoice (supplier, amount, due_date, OCR/bankgiro) | Gmail list + dedup set-diff + attachment download (extend `inbox.ts`) |
| Fuzzy bank-transaction → invoice matching | Due-date sweep (overdue/due_soon date math) |
| Compose the Swedish operator summary / todo prose | Fingerprint hash + edge-notify decision |
| | Open-period determination (Step 0) + idempotency guards |

The judgment kernels already exist as skills: `swedish-invoice-tools:classify-invoice`,
`extract-invoice-fields`, `match-bank-transactions`. Those become the small dispatched agents.

**Result:** `finance.ts` is the orchestrator (like `inbox.ts`, generalized); the LLM only fires when
there's a real new document to classify — which is also the no-op skip-gate. The 48-turn / $1 quiet
run collapses to a few cheap TS ops.

## Harness extensions needed (both small, both consistent)

1. **Structured return from an agent.** Today `out.json` carries `{status, summary, orders, replies}`.
   A `classify-extract` agent must return `{type, supplier, amount, due_date, …}` for the TS
   orchestrator to act on. Add a structured-result field to the `out.json` contract — agents already
   write `out.json`, so this is an extension, not a new mechanism.
2. **Keep judgment as dispatched agents, NOT a direct Anthropic API call.** A bare API call with
   structured outputs would be cheaper per-call, but it bypasses the queue/registry/agent model —
   that is the thing that would break modularity. Stay in the agent model; the win comes from
   *removing the procedure*, not from a cheaper call style.

## Migration order (incremental — do NOT boil the ocean)

1. **Skip-gate + due-date sweep + fingerprint + edge-notify → TS.** Reads `state.json` (already
   structured). Biggest, cleanest cut: kills the no-op cost, and gates the LLM on "is there real
   work." (This is "Phase 5 follow-up #3" from the interactive-finance plan, generalized.)
2. **State I/O → TS.** Own `state.md`/`state.json` read/write/collision-guard in code.
3. **Gmail list + dedup + download → TS.** Extend `inbox.ts`; hand the LLM a file, not a mailbox.
4. **Shrink the agent(s)** to classify-extract / reconcile / summarize only.

## Retire the markdown machine-state

An LLM re-parsing human-formatted `state.md` tables ("split on `|`, trim, skip header") every run is
the root smell. TS should own **structured JSON** as the source of truth; keep a rendered markdown
view *for the bookkeeper*, not as the thing the machine parses. `state.json` already exists for thin
metadata — grow it into the ledger, render `state.md` from it.

## Dashboard / visualization (follows the architecture, not the reverse)

- Today the constellation (`src/projection.ts`) shows **CORE + LLM agents only**; deterministic
  adapters are not nodes, and edges are **observed runtime delegations** (an *activity map*).
- The split implies: **clusters** (domain sub-constellations), **orchestrator-stars** (promote the
  adapters to a different kind of hub node), and eventually a **structure map** (domains/wiring) as a
  view distinct from the live activity map.
- **Guidance:** let the architecture lead. Give the finance domain a clear hub (`finance.ts`) and
  clearly-named satellites; the constellation grows a cluster to match, for free. Do not build the
  picture first and back-fill structure.

## Key facts (so a cold context doesn't re-derive them)

- Worker (`src/worker.ts`) runs `claude -p <prompt> --allowedTools <registry tools> --model <m>`, no
  bypass flag → `--allowedTools` is an **enforced gate** (non-matching tool calls auto-denied in
  headless mode). Reads `out.json`. Memory is injected via `recentChatMessages` (`chatMemoryLines`),
  not held by the model.
- Dispatcher (`src/dispatcher.ts`) `validRow`: `parent=null` rows skip the caller check (top-level);
  `can_be_called_by` enforced only when `parent != null`. Per-agent `max_concurrency` (entrepreneur=1).
- The daemon `entrepreneur` is self-contained (own state under Drive `<DRIVE_ROOT>/.doppelganger/`,
  vendored skills `collect-finance` + `month-close`), deliberately separate from the `/cfo-run`
  plugin's `.nilsark/`. **The split trades this "self-contained domain agent" elegance for
  testability/cost/determinism — a conscious trade.**
- Per `CLAUDE.md`: trunk-based, commit direct to `main`; run `npm run typecheck` + `npm test` in
  `doppelganger/` before pushing.

## Open decisions (resolve when reached)

- Exact shape of the `out.json` structured-result field (one freeform `result` blob vs typed per
  agent).
- How many judgment agents: one `classify-extract` (does both), or separate; whether `reconcile` and
  `summarize` are their own agents or stay in `finance.ts` + one LLM call.
- Whether `finance.ts` reads Drive state directly (gws shell, like `inbox.ts`) or via a thin state
  module shared with the agents.

## Decision log

- **LLM = judgment, TS = procedure** — apply the existing adapter/agent split to the entrepreneur;
  don't invent a new pattern.
- **Keep the modular agent model** — judgment stays as queue-dispatched `claude -p` agents, not a
  direct API call (that's what would break modularity).
- **Entry clusters vs domain clusters** — `chat`/`schedule` route inward; finance/calendar are
  domains. Some clusters are doors, some are domains; don't flatten the distinction.
- **Incremental migration, skip-gate first** — highest value, cleanest cut, reads existing `state.json`.
- **Architecture leads the visualization**, not the reverse.
