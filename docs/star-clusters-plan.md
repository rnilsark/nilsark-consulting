# Plan: Star clusters — LLM for judgment, TypeScript for procedure

Persistent working doc for the next architecture track: splitting the monolithic `entrepreneur`
agent into a **domain cluster** (a deterministic TS orchestrator + small judgment agents), and the
conceptual/visual model that follows. Survives context resets — **update as you go.** Companion to
`docs/interactive-finance-plan.md` and `docs/cfo-architecture.md`.

## Status

- **Phase:** BUILDING — **step 1 (the skip-gate) shipped**; steps 2–4 not started. The conceptual
  model is unchanged; this is the incremental, severable cost-and-determinism cut, with its safety
  net built in from the first commit (review #4).
- **Last updated:** 2026-06-21 (built step 1 — see "Step 1 — built" below).
- **Why — read this first, the framing sets the scope (review #1):** the driver is **architecture,
  not cost.** The win is determinism, testability, and decomposing the god-object (one `claude -p`
  doing orchestration + state I/O + classification + matching + prose), and retiring the
  markdown-reparse smell. LLMs are for judgment; `if`-statements are not. The ~$1.14/48-turn quiet
  run (~$35/mo) is a **symptom** that confirms the diagnosis — it is *not* the justification; $35/mo
  would never pay for a financial-records migration on its own.
- **Severability:** if you ONLY want the no-op spend gone, do **step 1 (the TS skip-gate) and stop** —
  it kills the cost with none of the cluster reframe. The full decomposition is an architecture
  investment; buy it for quality, not for the dollar figure. Be explicit which you're buying — they
  justify very different scope.

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
2. **Where judgment runs — sized, NOT asserted (review #2).** A bare Anthropic API call with native
   structured outputs is cheaper, lower-latency, and schema-enforced per classify; a dispatched
   `claude -p` agent pays cold-start + queue overhead. Split by whether the judgment needs tools:
   - **Tool-USING judgment (touches creds — credentialed reconcile / draft work) → stays a dispatched
     agent**, for the enforced `--allowedTools` gate. Non-negotiable.
   - **Tool-LESS judgment (`classify-extract` of a document already in hand — no creds, no tools) → a
     direct call is viable and probably better.** The agent channel buys it nothing here *except*
     **observability** (a dashboard node + a cost event), which `finance.ts` can emit itself. Don't
     force pure judgment through `claude -p` cold-start just to stay visible.
   - Note extension #1 (structured return on `out.json`) is essentially *structured-outputs-via-the-
     agent-channel* — right for the tool-using agents, redundant for a tool-less classify that could
     just call the API. **OPEN:** size per-call cost/latency vs the observability you'd hand-roll, and
     weigh that a direct path adds an API key + SDK to the box (a real second mechanism), before
     committing classify-extract to one or the other. Earlier this doc *asserted* "keep everything an
     agent"; that was under-justified — it's a sized trade, not a settled rejection.

## Safety: the skip-gate removes a self-correcting net (review #4 — do this BEFORE step 1)

The god-object's wastefulness *is* its safety net: re-deriving everything every run means it can't
permanently drop a document — a miss self-corrects on the next run. The skip-gate removes that net,
and the records are **financial**: a skip-gate **false-negative = a silently dropped invoice = a
missing verification for the bookkeeper**, with tax consequences. And the gate's judgment quality is
not measured yet. So before step 1 ships, the gate must be:

- **Conservative by construction** — skip only when *provably* nothing new (exact cursor + dedup); on
  ANY ambiguity, fire the LLM. A wasted run is cheap; a dropped invoice is not.
- **Logged for audit** — record every skip decision and its inputs, so you can review "what did TS
  skip" over the first months and catch a bad gate *before* trusting it.
- **Backstopped** — keep a periodic full sweep (e.g. weekly — the Phase-5 Option-B backstop) running
  even with the skip-gate, so anything wrongly skipped surfaces within days, not never. Retire the
  backstop only once the audit log shows the gate is trustworthy.

## Step 1 — built (2026-06-21)

The skip-gate is live as `doppelganger/src/adapters/finance.ts` — the finance orchestrator-star.
Shape, so a cold context doesn't re-derive it:

- **Wiring.** `entrepreneur/run` was removed from the unconditional `schedule.ts` `jobs`; the
  `financeHeartbeatCron` now calls `maybeEnqueueFinanceRun(db)`, which enqueues the run ONLY when work
  is (or might be) due. `decideGate` is a pure function; I/O (state read, audit log, clock) is injected
  for tests (`test/finance.test.ts`, 22 cases).
- **Conservative by construction (review #4).** Fires on ANY ambiguity: state.json missing/unreadable,
  `version ≠ 2`, a null stored fingerprint, an actionable item with a missing/non-ISO `due_date`, or a
  recomputed fingerprint ≠ the stored one. Skips ONLY when every open period's fresh fingerprint
  matches its stored one.
- **Backstop (review #4).** Reuses `lastEntrepreneurSuccess`: if no successful run landed within
  `financeBackstopMaxAgeHours` (default 168h / 7d), it fires unconditionally — the periodic full sweep.
  Also dedups: never piles a second `run` on a pending/running one.
- **Audit log (review #4).** Every decision (fire/skip + reason + ts) appends to
  `$DOPPELGANGER_HOME/finance-gate.jsonl` — review "what did TS skip" before trusting the gate; only
  then consider lowering the backstop.
- **The fingerprint is a PINNED cross-language contract.** TS (`computeFingerprint`) and the
  entrepreneur prose must hash byte-for-byte identically or the gate over-fires (cheap) or wrongly
  skips a due push (a miss). Pinned: actionable = non-acked items with bucket `due_soon`/`overdue`
  (items > 7d out are excluded); token = `"<docKey>|<bucket>"`; sort by `due_date`,`supplier`;
  newline-join; sha256; first 16 hex; empty set → `e3b0c44298fc1c14`. **If you touch one side, touch
  both and re-run the known-vector test.**
- **The additive data migration (slice 1b, self-healing).** `notify.items` entries now mirror
  `supplier`/`amount`/`due_date` (amount = the docKey's amount string, verbatim) so the gate reads
  `state.json` alone. Critically, the **inbox-intake path now projects a newly-filed unpaid item into
  `notify.items` but deliberately leaves `notify.fingerprint` stale** — that staleness is the signal
  the daily gate fires on. (If intake advanced the fingerprint, the gate would skip and the operator
  would never hear about the new invoice.) Old data with no `due_date` → the gate fires (self-heals on
  the next run that rewrites the item).
- **Known coverage edges (by design, backstop is the net):** standing EXPORT items and a month
  becoming close-ready don't change the fingerprint, so the *daily* gate won't fire for them — the
  weekly backstop and the event-driven inbox path cover those, exactly the net review #4 mandates.
  Likewise an *acknowledged* item silently going overdue is excluded from the fingerprint (acked items
  never are); the bank-reconcile path or the backstop catches it. Watch the audit log to confirm these
  hold before trusting the gate.

## Migration order (incremental — do NOT boil the ocean)

1. **[DONE] Skip-gate + due-date sweep + fingerprint + edge-notify → TS.** Reads `state.json` (already
   structured). Biggest, cleanest cut: kills the no-op cost, and gates the LLM on "is there real
   work." (This is "Phase 5 follow-up #3" from the interactive-finance plan, generalized.) See "Step 1
   — built" above. NOTE: the gate decides fire/skip; the *push itself* still runs in the LLM. Moving
   the fingerprint+todo composition fully into TS (so a push fires with NO LLM) is a later slice, to be
   taken only once the audit log shows the gate is trustworthy.
2. **State I/O → TS.** Own `state.md`/`state.json` read/write/collision-guard in code.
3. **Gmail list + dedup + download → TS.** Extend `inbox.ts`; hand the LLM a file, not a mailbox.
4. **Shrink the agent(s)** to classify-extract / reconcile / summarize only.

## Retire the markdown machine-state

An LLM re-parsing human-formatted `state.md` tables ("split on `|`, trim, skip header") every run is
the root smell. TS should own **structured JSON** as the source of truth; keep a rendered markdown
view *for the bookkeeper*, not as the thing the machine parses. `state.json` already exists for thin
metadata — grow it into the ledger, render `state.md` from it.

## Migration & cutover (in-flight months — DON'T skip this)

A state-FORMAT change can't ignore the open month: 2026-06 (and any unclosed prior) already has a
markdown `state.md` ledger on Drive. Same hazard class as the `is_direct` column + config lockstep.
Two change-types, two strategies:

- **Additive (gentle, no migration).** New *fields* on `state.json` — e.g. promoting `due_date` into
  the `notify` items so the due-date sweep runs in TS without parsing `state.md`. Absent on old data →
  the entrepreneur writes it on its next run; TS reads it once present. **Self-healing.** The early,
  high-value steps (skip-gate, due-date sweep, fingerprint, edge-notify) are mostly this.
- **Replacement (the hard one): one-time migration on the single box — NO dual-format code.** There
  is exactly **one install** (the Pi), so a state-format change is a controlled one-time operation,
  not a fleet rollout. Change the code to the clean target, deploy, then transform the Pi's existing
  `state.md` → structured JSON **once** (same shape as the `is_direct` backfill). Do **not** burden
  the code with transitional dual-format support — migrate the *data* to match the *code*. A
  month-boundary cutover is available if ever wanted, but it is **not** the default: the operator
  prefers the clean design + a one-time migration over carrying compatibility shims.

Because the records are **financial** (they feed the bookkeeper), keep migrations **validated and
reversible** even while moving fast: diff the migrated JSON against the source `state.md`, and keep
the old `state.md` (Drive versions it anyway) until the new path is confirmed. Aggressive on design,
careful on the data.

**"No dual-format code" ≠ "no code reads both" (review #3).** The *running system* carries no
dual-format branches — good. The *one-time migration script* obviously must read old `state.md` and
write new JSON; that's a throwaway tool, not running-system code. Don't conflate them.

**Sequencing is load-bearing.** Step 2 (TS owns the *write* path) and the migration are entangled:
once TS owns write, the entrepreneur no longer regenerates the markdown, so the self-heal is gone. So
the migration runs **before or atomically with** the step-2 cutover, never after. Concretely: stop
the service → run the migration (markdown → JSON) → diff-validate → start the new code. **Abort
criterion + rollback:** if the diff shows any material disagreement in the Documents / payment rows
mid-month, abort — keep `state.md`, roll the code back via `stable`, re-run the entrepreneur on the
markdown path, fix the migration offline. Decide the abort criterion up front, not during the cutover.

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
- **Driver is architecture, not cost (review #1)** — determinism / testability / god-object
  decomposition; the ~$35/mo is a symptom. The skip-gate (step 1) is **severable** as the cost-only win.
- **Where judgment runs is OPEN, not settled (review #2)** — tool-USING judgment stays a dispatched
  agent (enforced gate); tool-LESS classify-extract may be a direct structured-output API call, since
  the agent channel only buys observability there. Size it before committing; don't assert.
- **The skip-gate must restore the net it removes (review #4)** — conservative-by-construction
  (unsure → fire the LLM), audit-logged, with a periodic backstop sweep until the gate is trusted. A
  dropped invoice (missing verification) outweighs a wasted run.
- **Migration sequencing (review #3)** — the running system carries no dual-format branches, but the
  one-time migration script reads both; it runs before/atomically with the step-2 write cutover, with
  a pre-agreed abort criterion + `stable` rollback.
- **Entry clusters vs domain clusters** — `chat`/`schedule` route inward; finance/calendar are
  domains. Some clusters are doors, some are domains; don't flatten the distinction.
- **Incremental migration, skip-gate first** — highest value, cleanest cut, reads existing `state.json`.
- **Step 1 shipped as `finance.ts` (2026-06-21)** — gate decides fire/skip (LLM still does the push);
  conservative-by-construction + backstop + audit log + dedup; fingerprint pinned byte-for-byte across
  TS and the entrepreneur prose; `notify.items` grew additive `supplier`/`amount`/`due_date`, and the
  inbox-intake path feeds it while leaving the fingerprint stale on purpose. See "Step 1 — built".
- **Architecture leads the visualization**, not the reverse.
- **Migration: single Pi install → one-time hard migration, NO dual-format code.** Additive fields
  self-heal; for a ledger-format replacement, change the code and migrate the Pi's data to match (like
  the `is_direct` backfill). Validate + keep a backup (financial records), but don't contort the
  design to avoid migrating. Best harness > avoiding breaking changes; long-term quality is the goal.
