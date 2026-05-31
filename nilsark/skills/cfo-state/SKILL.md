---
name: cfo-state
description: Read and update cfo-state.json — the thin run-orchestration state for the CFO heartbeat (last-run timestamps, todo dedup, bank-export status). Use this skill in /cfo-run. Keep it tiny; accounting facts belong in state.md, not here.
---

# CFO Run State (cfo-state.json)

`cfo-state.json` holds **only** cross-run orchestration metadata that `state.md` does not
model. It is **not** an accounting ledger.

## The boundary (read this first)

| Question | Source of truth |
|---|---|
| Is a document classified / paid / sent to bookkeeper? | **`state.md`** (`payment_status`, `fortnox_sent`) |
| Is the month closed? | **`state.md`** (`Month-close sent`) |
| When did the last heartbeat / close run? | `cfo-state.json` (`last_run`) |
| Was the todo already emitted today? | `cfo-state.json` (`todo_last_emitted`) |
| Has the bank export been dropped / reconciled? | `cfo-state.json` (`export_status`) |

**Never** copy `sent`/`paid`/`closed` facts into `cfo-state.json` — derive them from
`state.md` at read time. Duplicating them is the one architectural failure mode to avoid.

## Location

- Local: `$STAGING_DIR/.state/cfo-state.json`
- Drive mirror: `<DRIVE_ROOT_FOLDER_ID>/.nilsark/cfo-state.json`
  (so it survives a machine change)

Read the local copy; if absent, download the Drive mirror; if neither exists, initialize
from the template below. Always write both local and Drive mirror at the end of a run.

## Template

```json
{
  "version": 1,
  "last_run": { "cadence": null, "monthly_close": null },
  "periods": {}
}
```

Per-period entry (created lazily when a period is first touched):

```json
"2026-05": { "todo_last_emitted": null, "export_status": "pending" }
```

`export_status`: `pending → dropped → reconciled`.
- `pending` — no bank export seen for the period.
- `dropped` — a statement is in the drop folder / ingested, not yet matched.
- `reconciled` — matching has run and outgoing transactions are accounted for.

## Update rules

- Set `last_run.cadence` to the run's ISO-8601 timestamp at the end of every `/cfo-run`.
- Set `last_run.monthly_close` to `YYYY-MM` when `/month-close` completes.
- Set `periods.<YYYY-MM>.todo_last_emitted` to the run date (`YYYY-MM-DD`) after emitting a todo.
  Use it to avoid re-emitting an identical todo more than once per cadence window.
- Advance `export_status` as the bank export progresses through ingest + matching.

## Idempotency contract

A second `/cfo-run` on the same day must: create no new bookkeeper drafts (guard via
`state.md` `fortnox_sent`), re-list no paid invoices (guard via `payment_status`), and not
re-emit a duplicate todo (guard via `todo_last_emitted`). Read both stores before acting.
