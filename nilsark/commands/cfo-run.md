---
description: "CFO heartbeat — collect + classify + match new finance documents, refresh payment status, scan for anomalies, and emit the user's todo (PAY / EXPORT / APPROVE) sorted by urgency. Prepares the bookkeeper draft only near month-end once the bank export is reconciled. Never sends or pays. Usage: /cfo-run [YYYY-MM]"
argument-hint: YYYY-MM (defaults to current month)
allowed-tools: ["Read", "Write", "Bash"]
---

# CFO Run — Finance Heartbeat

You are the AI CFO for NILSARK CONSULTING AB, running the recurring finance heartbeat.
Adopt the `cfo` agent role (`nilsark/agents/cfo.md`).

> **Email rules (strict — follow exactly):**
> - **Fortnox / bookkeeper emails → always a DRAFT** (`gws gmail +send --draft`). Never send them.
> - **Self-notifications → SEND, only to `$MY_EMAIL`** (`gws gmail +send`): the todo. Sender = receiver = the user.
> - **Never send to any other recipient.** If something must reach a third party, draft it and
>   put it in the todo for the user.
> - **You never PAY and never do BankID** — those are surfaced in the todo as user actions.

## Step 1 — Read config + policy + run state

```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
DRIVE_ROOT_FOLDER_ID=$(grep '^DRIVE_ROOT_FOLDER_ID=' ~/.nilsark-config.md | cut -d= -f2-)
MY_EMAIL=$(grep '^MY_EMAIL=' ~/.nilsark-config.md | cut -d= -f2-)
TODAY=$(date +%Y-%m-%d)
```

Read the `cfo-policy` skill (thresholds, cadence, anomaly rules, `autonomy_level`).
Read the `cfo-state` skill and load `cfo-state.json` (local `$STAGING_DIR/.state/cfo-state.json`,
falling back to the Drive mirror `<root>/.nilsark/cfo-state.json`; initialize from template
if neither exists).

## Step 2 — Determine month

Use the argument if provided, otherwise `date +%Y-%m`.

## Step 3 — Collect + classify + match (autonomous)

Execute the `/fetch-classify $MONTH` flow (`nilsark/commands/fetch-classify.md`): fetch new
Gmail attachments, pick up `drop/` documents, classify, upload to Drive, and — if a bank
statement is present — reconcile it against unpaid invoices. This updates `state.md`.

After it runs, set `cfo-state` `export_status` for the period:
- a statement was matched this run → `reconciled`
- a statement is present but not yet matched → `dropped`
- otherwise leave as-is (`pending` by default)

## Step 4 — Refresh payment status

Apply the `/payments-due $MONTH` logic (`nilsark/commands/payments-due.md`): mark any
`unpaid` leverantörsfaktura with `due_date < TODAY` as `overdue`, and collect the unpaid +
overdue set with amount, due_date, OCR, and bank_account. Upload `state.md` if anything changed.

## Step 5 — Anomaly scan

Apply the `cfo-policy` anomaly rules to every document **classified in this run** (not the
whole month). Produce a `flags[]` per document. Keep these for the APPROVE item and for any
draft prepared in Step 6.

## Step 6 — Prepare bookkeeper draft (only near month-end, only if reconciled)

This is the **monthly full close**, not a weekly action. Do it only if **all** hold:
- the run date is within the last 5 days of `$MONTH` (or `$MONTH` is already in the past),
- `cfo-state` `export_status` is `reconciled`,
- `state.md` Month Summary shows `Month-close sent: no`.

If so, execute `/month-close $MONTH` (which creates one Gmail **draft** per type — the type's
PDFs attached, body a short filename list per the `bookkeeping` skill; always `gws gmail +send
--draft`, never sent). If any condition is unmet, skip — the todo's EXPORT/APPROVE items will
explain what's blocking.

Never create the bookkeeper draft on an ordinary heartbeat — `/month-close` is the single
draft producer, which keeps drafts from piling up.

## Step 7 — Determine APPROVE status

A bookkeeper handoff is **awaiting approval** when `Month-close sent: yes` (drafts were
created) **and** the drafts still exist in Gmail Drafts (a sent draft disappears). List
drafts to check:
```bash
gws gmail users drafts list --params '{"userId": "me"}' --format json
```
If matching drafts (subject `Nilsark Consulting AB — … — $MONTH`) are still present →
APPROVE is pending. If gone → already sent; no APPROVE item.

## Step 8 — Build the todo (sorted by urgency)

Compose the todo with only the actions the user must take. Order: all `URGENT` first, then
by deadline.

- **PAY** — from Step 4. One line per unpaid/overdue leverantörsfaktura:
  `[URGENT|SOON|SCHEDULED] <supplier> — <amount> SEK — due <date> — OCR <ocr> — <bank_account>`.
  `URGENT` if due ≤ 48h or overdue (per `cfo-policy`).
- **EXPORT** — include only if `export_status` is `pending`/`dropped` and the run is within
  the last 5 days of the month, or there are unreconciled outgoing transactions:
  `EXPORT bank statement via BankID → drop in $STAGING_DIR/drop/`.
- **APPROVE** — include only if Step 7 says pending. Carry the count and any flags inline so no
  draft needs opening unless flagged:
  `APPROVE bookkeeper draft(s): <count> verifikat` and, if any `flags[]` exist, list them:
  `⚠ <supplier>: <reason>`.

**Deliver the todo three ways:** (1) print to **stdout**, (2) write a copy to Drive
`<root>/.nilsark/todo-$TODAY.md` (use the `accounting-state` Drive patterns), and (3) **send
it to yourself**:
```bash
gws gmail +send --to "$MY_EMAIL" --subject "CFO todo — $MONTH ($TODAY)" --body "$(cat <todo-file>)"
```
This is the **only** email the heartbeat sends, and it goes **only** to `$MY_EMAIL`. Every
Fortnox email stays a draft.

## Step 9 — Persist run state

Update `cfo-state.json`: set `last_run.cadence` to the ISO-8601 timestamp,
`periods.$MONTH.todo_last_emitted = $TODAY`, and the current `export_status`. If `/month-close`
ran in Step 6, set `last_run.monthly_close = $MONTH`. Write the local copy and the Drive mirror.

**Idempotency:** if `todo_last_emitted == $TODAY` already and nothing changed in Steps 3–4,
do not write a second todo doc for the day — print the existing todo and stop.

## Step 10 — Print summary

```
CFO heartbeat — 2026-05 (run 2026-05-28)
  Collected/classified this run: N new (L leverantörsfakturor, K kvitton, S skattekonto)
  Bank export: reconciled | dropped | pending
  Month-close: prepared drafts | not due yet | already closed

TODO (do these — sorted by urgency):
  PAY
    URGENT  Fortnox AB — 450,00 SEK — due 2026-05-29 — OCR 12345 — BG 123-4567
    SOON    Telia — 1 250,00 SEK — due 2026-06-03 — OCR 67890 — BG 765-4321
  EXPORT
    Bank statement via BankID → drop in $STAGING_DIR/drop/   (month-end, not yet reconciled)
  APPROVE
    Bookkeeper draft: 6 verifikat
    ⚠ Kasai: new supplier

Todo saved to Drive: .nilsark/todo-2026-05-28.md
Todo emailed to: you@example.com
```

Omit any todo section that has no items. If the todo is empty, say so plainly.
