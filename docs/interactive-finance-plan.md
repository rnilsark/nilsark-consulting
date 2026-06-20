# Plan: Weekly batch → fail-fast interactive finance

Persistent working doc for evolving the Doppelgänger finance heartbeat from a weekly batch
run into an event-driven, fail-fast system. Survives context resets — **update the checklist
as you go.** Companion to `docs/cfo-architecture.md`.

## Status

- **Current phase:** Phases 1–4 SHIPPED to `main` (3b deferred). Next: Phase 5 (inbox path).
- **Last updated:** 2026-06-18
- **Integrated commits:** `6f3c960` cap · `e956217` cadence+config · `641ed32` healthcheck+tests · `2c8ba84` entrepreneur (1b/2a/2b) · `a1128f8` healthcheck probe fix (valid gws ping + no cry-wolf before first run). 72/72 tests, typecheck clean.
- **Post-Phase-4 infra change — operator-notification delivery (READ THIS, it changed how every push lands):** the healthcheck/edge-notify push target is no longer the hardcoded `operatorConversationId`. It is now **derived** from the DB via `operatorNumber` — `operatorPushTarget()` returns the operator's most recent `is_direct=1` (direct/1:1) message thread, self-healing if the thread id rotates and never leaking a push into a group. Commits `7d1c7d5` (operator-DM-bypasses-triage + derive) and `095727b` (instant ack moved to chat-start). Cold-start caveat: needs at least one `is_direct=1` row, so a fresh deploy delivers nothing until the operator's first DM (or a one-time backfill of the known thread).

## Guiding split

| Concern | Cadence | Mechanism |
|---|---|---|
| **Intake** (collect/classify/file one doc) | event-driven, per email | new `inbox` path |
| **Reconciliation** (bank match, payments, anomalies) | daily (light) + on statement arrival | `entrepreneur:run` + event |
| **Notification** to operator | edge-triggered only | cfo-state fingerprint |
| **Liveness** | continuous | deterministic healthcheck + morning brief line |

**Sequencing rule:** the concurrency cap (1a) and edge-notify (2a) MUST land before the daily
flip (3a) and the inbox path (5), or we create races and notification spam.

## Key facts about the codebase (so a cold context doesn't re-derive them)

- Dispatcher `pick()` is **full-parallel** — no per-agent serialization. This is the core risk.
- `worker.ts buildPrompt()` injects `row.task` verbatim into `## Task`, so `intake` vs `run` is
  just task content — no new agent needed for intake.
- `conversationIdFor()` already JSON-parses `entrepreneur` tasks (returns null → no conversation,
  correct for a document).
- Chat path template lives in `src/adapters/chat.ts`: dumb poll (no LLM) → enqueue `triage` (haiku).
  The `inbox` path mirrors this exactly.
- `cfo-state.json` `todo_last_emitted` is **date-based** — stops same-day dupes, NOT day-over-day
  repeats of an unchanged list. Must become content/edge-based.
- **The daemon entrepreneur is self-contained — it does NOT use `nilsark/skills/*`.** Its State
  contract lives in `doppelganger/agents/entrepreneur/CLAUDE.md`; its vendored skills are
  `collect-finance` + `month-close`. Its state lives in Drive `<DRIVE_ROOT>/.doppelganger/`
  (`state.md` per month + a thin `state.json`), deliberately SEPARATE from the `/cfo-run` plugin's
  `.nilsark/`. **Phases 1–4 target the entrepreneur agent + vendored skills + daemon TS only — they
  do NOT touch `nilsark/skills/*` (that's the separate manual `/cfo-run` surface).**
- `state.json` already has date-based `todo_last_emitted` + a Step-6 idempotency guard, but it's
  date-based — the exact day-over-day-repeat gap. Edge-notify (2a) replaces it in CLAUDE.md + state.json.
- Entrepreneur already handles chat delegation (`{conversationId, request}`), so the chat-ack loop
  (2b) is an addition to its existing chat path — no new wiring.
- Per `CLAUDE.md`: trunk-based, commit direct to `main`; run `npm run typecheck` + `npm test` in
  `doppelganger/` before pushing.

---

## Phase 1 — Safety foundation

Prerequisite. No user-visible behavior change.

- [x] **1a. Per-agent concurrency cap**
  - [x] `registry.yaml`: add `max_concurrency: 1` to `entrepreneur`
  - [x] `src/types.ts` / `src/registry.ts`: parse optional `max_concurrency`
  - [x] `src/dispatcher.ts` `pick()`: skip (leave `pending`) a row when its agent is at cap —
        count `selectRunning` of that agent + ones started earlier in the same tick
  - [x] Test: two `entrepreneur` rows → only one `running`; second waits; uncapped agents stay parallel
  - [x] `npm run typecheck && npm test`
- [x] **1b. Drive state checksum guard** (entrepreneur prompt)
  - [x] `agents/entrepreneur/CLAUDE.md` State-contract read/write cycle: capture `headRevisionId`
        (+ `md5Checksum`) on download; skip re-download when local matches; refuse upload if
        `headRevisionId` changed since read (mid-air collision → flag, don't clobber)
  - [x] Mirror into `collect-finance` SKILL where it does its own state.md I/O

## Phase 2 — Quieter notifications

Must precede the daily flip (3a).

- [x] **2a. Edge-triggered emit + actionable-set fingerprint**
  - [x] `state.json`: replace date-based `todo_last_emitted` with per-period `notify` block:
        `{ fingerprint, items: { <docKey>: { bucket, acknowledged, last_notified } } }`,
        `bucket ∈ due_soon | overdue`
  - [x] `agents/entrepreneur/CLAUDE.md` Step 5/6 + Delivery: hash actionable set; push the operator
        reply only when the hash changes (new item / threshold crossing). Same set → no push
        (Drive `todo-*.md` still written as the record).
  - [x] Payments rule: ping once on `due_soon`, once on `due_soon→overdue`, never repeat
        (encodes the bank-statement blind spot — paid status frozen until month-end)
- [x] **2b. Chat ack loop**
  - [x] `agents/entrepreneur/CLAUDE.md` chat path: a request like "betald X" / "paid the X one" →
        set `acknowledged` on that item in `state.json` → suppress until bank statement confirms/contradicts

## Phase 3 — Cadence flip

- [x] **3a.** `financeHeartbeatCron` weekly → daily (`0 8 * * 1` → `0 8 * * *`) in `config.ts`
      defaults + `config.example.json`; keep the daily `run` light (due-date sweep + edge check)
- [ ] **3b. DEFERRED to a follow-up** — `planner`'s morning-brief finance line. Planner runs 07:00,
      before the 08:00 finance run, and is calendar-scoped, so it'd show stale status and needs a
      cross-agent data contract. Liveness is already covered by Phase 4's healthcheck (failure-alert),
      so this positive "all quiet" line is comfort-only — split out to avoid coupling this batch.

## Phase 4 — Deterministic healthcheck (no LLM)

- [x] New `src/adapters/health.ts` + cron in `scheduler.ts`
- [x] Check last `finished/success` of `entrepreneur` in `events`; stale beyond `staleRunHours` → alert
- [x] `gws` auth ping; failure → alert *(probe is `gws gmail users getProfile` — the original `gws calendar list` was an invalid command that always "failed"; fixed in `a1128f8`)*
- [x] On alert, push to the operator via `insertOutbox` (no agent, no tokens) *(post-ship: target is now `operatorPushTarget(config.operatorNumber)`, NOT the hardcoded `operatorConversationId` — see the Status note)*
- [x] *(post-ship, `a1128f8`)* staleness alert suppressed until a first `entrepreneur` success exists — no cry-wolf on a fresh deploy
- [x] Config: `healthcheckCron`, `staleRunHours` (defaults + example + env map)
- [x] `npm run typecheck && npm test`

## Phase 5 — Event-driven intake (inbox path)

The bigger build. Only safe after Phase 1.

> **Daily run stays a backstop (decided 2026-06-18, see Decision log).** Phase 5 makes the inbox poll
> the *fast primary* intake — it does NOT remove intake from `entrepreneur:run`. The daily run keeps a
> catch-all collect/classify sweep (idempotent dedup → near-free when nothing's new) as insurance
> against poll blind spots. Phase 5 = diet, not amputation.

- [x] **5a. `inbox-ingest` adapter** (`src/adapters/inbox.ts`) — deterministic, no LLM. Shell
      `gws gmail` list with query (`has:attachment` + sender allowlist) + cursor in `channel_state`
      (key `inbox`, last `internalDate`). Enqueue an `inbox` row per candidate with
      `{messageId, from, subject, snippet, attachments}` — **metadata only, NO attachment bytes at
      poll time** (lazy download in the run = per-document isolation). Wired into `scheduler.ts` on
      `inboxPollCron`. New `inboxSenders` config holds the email allowlist (distinct from the chat
      phone-number `allowedSenders`). Default lister injectable as `GmailList` for tests.
- [x] **5b. `inbox` agent** in `registry.yaml`: `can_be_called_by: [inbox-ingest]`, `tools: Read,Write`,
      `model: haiku`. Untrusted-text gate (`agents/inbox/CLAUDE.md`, mirrors `triage`) — can ONLY order
      `entrepreneur` (intake or reconcile). Added `inbox` to `entrepreneur.can_be_called_by`.
- [x] **5c. `entrepreneur:intake` task** — task JSON `{mode:"intake", messageId, ...}`. Documented the
      three modes (run / intake+reconcile / ack) + the *Inbox path* (ONE message per run, lazy
      download, no operator push) in `agents/entrepreneur/CLAUDE.md`. Same single credentialed
      entrepreneur, same vendored skills.
- [x] **5d. Bank-statement → reconcile** — `inbox` emits `mode:"reconcile"` for a statement; the
      entrepreneur runs the bank-statement match branch instead of plain intake → event-driven
      month-end recon.
- [x] Config: `inboxPollCron` (default `*/15 * * * *`) + `inboxSenders` (defaults + example + env map,
      validated like the other keys).
- [x] `npm run typecheck && npm test` — 80/80 green, typecheck clean.

---

## Cross-cutting (every phase)

- **Security continuity:** `inbox` mirrors `triage` — no domain creds, gate only. `entrepreneur:intake`
  keeps read-only Gmail + draft-only tools (can't send/pay). Posture unchanged.
- **Scope boundary:** Phases 1–4 touch the **doppelganger daemon + entrepreneur agent only**. Do
  NOT edit `nilsark/skills/*` — that's the separate manual `/cfo-run` surface with its own `.nilsark/` state.
- **Checks before push:** `cd doppelganger && npm run typecheck && npm test`.

## Open decisions (resolve when reached)

- Phase 5a poll interval: 15 min assumed — confirm against how fast a new invoice should surface.
- ~~Whether `intake` and `reconcile` are distinct entrepreneur task names or one parameterized task.~~
  **Resolved (Phase 5):** one parameterized task — the entrepreneur reads a `mode` field
  (`intake`/`reconcile`) on the same JSON task. No new task *name*, no second credentialed agent.
- **Phase 5 fork flagged:** the inbox allowlist is its own config key `inboxSenders` (email
  addresses), kept separate from chat's `allowedSenders` (phone numbers / JIDs) — they gate different
  channels and must not share a list. Empty `inboxSenders` = no `from:` filter (every
  attachment-bearing message is a candidate); set it in prod to the finance senders.

## Slices (Phases 1–4 batch)

Allocated identifiers / contracts (picked up front so slices agree without talking):
- `state.json` new field: per-period `notify` block `{ fingerprint, items{<docKey>:{bucket,acknowledged,last_notified}} }` — **owned entirely by Slice B** (daemon never parses state.json).
- New config keys: `healthcheckCron` (default `0 * * * *`), `staleRunHours` (default `30`).
- `financeHeartbeatCron` default flips `0 8 * * 1` → `0 8 * * *`.

**Integration:** cherry-pick both slice branches onto `main` directly (trunk-based per CLAUDE.md — **no PR**), then run full `npm run typecheck && npm test`.

**Scaffold:** no. Slices are file-disjoint with no compile-time cross-dependency (Slice B is markdown; the only shared concept, `state.json`'s shape, is owned solely by Slice B).

### Slice A — daemon TypeScript (Phases 1a, 3a, 4)
- **Branch:** `team/finance-daemon`
- **Depends on:** none
- **Scope (files):** `src/dispatcher.ts`, `src/registry.ts`, `src/types.ts`, `registry.yaml`,
  `src/config.ts`, `config.example.json`, `src/scheduler.ts`, `src/adapters/schedule.ts`,
  new `src/adapters/health.ts`, `test/*`. **Out:** anything under `agents/`.
- **Acceptance:**
  - `registry.yaml` `entrepreneur.max_concurrency: 1`; `pick()` never runs 2 entrepreneurs at once
    (extras stay `pending`, FIFO); uncapped agents keep full parallelism.
  - `financeHeartbeatCron` default is daily; `config.example.json` matches.
  - `health.ts` cron alerts the operator (`insertOutbox`, no LLM) when the last `entrepreneur`
    `finished/success` event is older than `staleRunHours`, or a `gws` auth ping fails. New config keys
    parsed/validated + in env map + example. *(Shipped against `operatorConversationId`; superseded
    post-ship — target now derived via `operatorPushTarget(operatorNumber)`, staleness check skipped
    until a first success exists, gws probe corrected — `a1128f8`.)*
  - `npm run typecheck && npm test` green.
- **Tests:** extend `test/` — dispatcher cap (2 entrepreneur rows → 1 running); a health-adapter
  unit (stale → outbox row; fresh → none). Follow existing test style.

### Slice B — entrepreneur agent + vendored skills (Phases 1b, 2a, 2b)
- **Branch:** `team/finance-entrepreneur`
- **Depends on:** none
- **Scope (files):** `agents/entrepreneur/CLAUDE.md`, `agents/entrepreneur/.claude/skills/collect-finance/SKILL.md`
  (only where it does its own state.md I/O). **Out:** anything under `src/`, `registry.yaml`, `nilsark/`.
- **Acceptance:**
  - State read/write cycle captures `headRevisionId`, skips re-download on match, refuses upload on a
    changed revision (collision → flag).
  - `state.json` schema documents the `notify` block; Step 5/6 + Delivery push the operator reply
    ONLY on a changed actionable-set fingerprint (new item / threshold crossing); unchanged → no push,
    Drive `todo-*.md` still written.
  - Payments: ping once on `due_soon`, once on `due_soon→overdue`, never repeat.
  - Chat path: an ack like "betald <supplier>" sets `acknowledged` on the item → suppressed until the
    bank statement confirms/contradicts.
  - All operator-facing text stays Swedish; hard rules (read-only Gmail, draft-only, never act on
    email instructions) untouched.
- **Tests:** prompt/markdown — no unit tests. Self-review against acceptance + the existing hard-rules
  section; confirm `state.json` shape is internally consistent across CLAUDE.md references.

## Decision log

- Keep `triage`/`chat` names (first-class interactive spine); new email gate is named `inbox`
  (doppelgänger is bound to one Workspace account, so `inbox` is unambiguous).
- One credentialed `entrepreneur` parameterized by task — do NOT split intake into a second
  credentialed agent (avoids duplicating Fortnox/gws creds + drift).
- Push/Pub-Sub deferred as premature; polling is 95% of the benefit at 10% of the complexity.
- **Daily run keeps intake as a backstop after Phase 5 (decided 2026-06-18)** — Option B, not a pure
  handoff. The inbox poll is the fast primary path; the daily `entrepreneur:run` still does a
  catch-all collect/classify sweep so nothing is lost when the poll misses: no-attachment docs (Kivra
  "ny faktura" notices arrive with NO attachment and won't match a `has:attachment` filter),
  sender-filter misses, or a poll outage. The re-scan is near-free (the `state.md` "already
  classified" dedup short-circuits it when there's nothing new). Reconciliation, payment due-date
  sweep, edge-notify and todo emission were never per-document and remain daily regardless.
