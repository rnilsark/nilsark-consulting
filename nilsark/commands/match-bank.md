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

Look for CSV files in `$STAGING_DIR/$MONTH/`:
```bash
ls "$STAGING_DIR/$MONTH/"*.csv 2>/dev/null
```

- If exactly one CSV is found: use it.
- If multiple CSVs are found: list them and ask the user which one to use before continuing.
- If no CSV is found: stop and tell the user to export their bank statement CSV and drop it in `$STAGING_DIR/$MONTH/`.

## Step 4 — Download state.md

Download state.md from Drive using the standard pattern (see accounting-state skill).

## Step 5 — Read and Parse the CSV

Use the Read tool to read the CSV file. Apply the `match-bank-transactions` skill to identify the bank format and parse the columns.

## Step 6 — Build Invoice List

From the Documents table in state.md, collect all rows where:
- `type = leverantorsfaktura`
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

Upload the updated state.md back to Drive.

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

Still unpaid invoices:
  - Fortnox AB — 450,00 SEK — due 2026-04-10

Summary: 2 matched, 1 fuzzy, 2 unmatched transactions, 1 invoice still unpaid
```
