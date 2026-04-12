---
description: "Match a SEB or Handelsbanken bank statement CSV from the staging folder against invoices in state.md. Updates payment status and reports unmatched transactions. Usage: /match-bank [YYYY-MM]"
argument-hint: YYYY-MM (defaults to current month)
allowed-tools: ["Read", "Bash"]
---

# Match Bank Statement Transactions

You are matching bank transactions against unpaid invoices for NILSARK CONSULTING AB using the `match-bank-transactions` skill from `swedish-invoice-tools`.

## Step 1 — Read Config

```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
DRIVE_ROOT_FOLDER_ID=$(grep '^DRIVE_ROOT_FOLDER_ID=' ~/.nilsark-config.md | cut -d= -f2-)
```

## Step 2 — Determine Month

Use argument if provided, otherwise `date +%Y-%m`.

## Step 3 — Find the Bank Statement CSV

First check local staging:
```bash
ls "$STAGING_DIR/$MONTH/"*.csv 2>/dev/null
```

- If exactly one CSV is found locally: use it. Skip the Drive check entirely.
- If multiple CSVs are found locally: list them and ask the user which one to use before continuing.
- If no CSV found locally: proceed to Step 4 first to resolve `NILSARK_FOLDER_ID`, then return here.

## Step 4 — Download state.md

> **Auth guard:** If any `gws` command in this command exits with a non-zero code and its output contains "auth", "token", "unauthenticated", "unauthorized", or "login", stop immediately and run `/nilsark:gws-auth`. After the user completes auth, retry from this step. This guard applies to all gws calls in all subsequent steps.

Download state.md from Drive using the standard pattern (see `nilsark:accounting-state` skill). This resolves `NILSARK_FOLDER_ID` as a side-effect.

**If no local CSV was found in Step 3**, check the `.nilsark/` folder in Drive after completing the state.md download:
```bash
gws drive files list --params '{"q": "'\''<NILSARK_FOLDER_ID>'\'' in parents and trashed=false and name contains '\''.csv'\''"}' --format json
```

If a CSV is found in Drive: download it to `$STAGING_DIR/$MONTH/` and proceed:
```bash
gws drive files get --params '{"fileId": "<CSV_FILE_ID>", "alt": "media"}' -o "$STAGING_DIR/$MONTH/<filename>"
```

- If exactly one CSV is found in Drive: use it.
- If multiple CSVs are found in Drive: list them and ask the user which one to use before continuing.
- If no CSV is found anywhere: stop and tell the user to export their bank statement CSV and upload it to `YYYY-MM/.nilsark/` in Google Drive, then re-run.

## Step 5 — Read and Parse the CSV

Use the Read tool to read the CSV file. Apply the `match-bank-transactions` skill to identify the bank format and parse the columns.

## Step 6 — Build Invoice List

From the Documents table in state.md, collect all rows where:
- `type = leverantörsfaktura`
- `payment_status` is `unpaid` or `overdue`

## Step 7 — Match Transactions

Apply the `match-bank-transactions` skill rules to each outgoing transaction (Belopp < 0).

For each match found:
- Update `payment_status = paid` in the Documents table
- Record the match in the Bank Statement Transactions table

For unmatched transactions, add them to the Bank Statement Transactions table with `match_confidence = unmatched`.

## Step 8 — Update Month Summary

Recount unpaid invoices and update the Month Summary.

## Step 9 — Upload state.md

Upload the updated state.md back to Drive (see `nilsark:accounting-state` skill for the upload pattern).

## Step 10 — Print Report

```
Bank Match Report — 2026-03

Matched (exact):
  ✓ Telia Sverige AB — 1 250,00 SEK — paid 2026-03-20

Matched (fuzzy — review recommended):
  ~ AWS EMEA SARL — 890,00 SEK — matched on amount+name, no OCR

Unmatched bank transactions (outgoing, no invoice found):
  - 2026-03-05 | Skatteverket | -8 500,00 SEK
  - 2026-03-25 | ICA Maxi | -1 200,00 SEK

→ If any of these are paper receipts, email them to yourself so they
  appear in the next /fetch-classify run.

Still unpaid invoices:
  - Fortnox AB — 450,00 SEK — due 2026-04-10

Summary: 2 matched, 1 fuzzy, 2 unmatched transactions, 1 invoice still unpaid
```
