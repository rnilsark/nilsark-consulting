---
description: "List all unpaid leverantörsfakturor for the month with due dates and amounts. Flags overdue items. Usage: /payments-due [YYYY-MM]"
argument-hint: YYYY-MM (defaults to current month)
allowed-tools: ["Bash"]
---

# Unpaid Leverantörsfakturor

You are checking payment status for NILSARK CONSULTING AB.

## Step 1 — Read Config

```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
DRIVE_ROOT_FOLDER_ID=$(grep '^DRIVE_ROOT_FOLDER_ID=' ~/.nilsark-config.md | cut -d= -f2-)
```

## Step 2 — Determine Month

Use argument if provided, otherwise `date +%Y-%m`.

## Step 3 — Download state.md

Download state.md from Drive following the standard pattern (see accounting-state skill).

## Step 4 — Get Today's Date

```bash
TODAY=$(date +%Y-%m-%d)
```

## Step 5 — Filter Unpaid Invoices

From the Documents table, select all rows where:
- `type = leverantorsfaktura`
- `payment_status` is `unpaid` or `overdue`

For each selected row:
- If `due_date < TODAY` AND `payment_status = unpaid`: update it to `overdue` in the in-memory state
- Otherwise keep as-is

## Step 6 — Upload state.md (if any statuses changed)

If any rows were updated to `overdue`, upload the updated state.md back to Drive.

## Step 7 — Print Report

Output a markdown table:

```
# Unpaid Leverantörsfakturor — 2026-03

| Supplier | Amount | Currency | Due Date | OCR | Bank Account | Status |
|---------|--------|---------|---------|-----|-------------|--------|
| Telia Sverige AB | 1 250,00 | SEK | 2026-04-15 | 1234567890 | BG 123456-7 | unpaid |
| AWS EMEA SARL | 890,00 | SEK | 2026-03-28 | — | — | OVERDUE |

Total outstanding: 2 140,00 SEK
Overdue: 1 invoice
Due within 7 days: 0 invoices
```

Use **OVERDUE** in uppercase for overdue items to make them visually prominent.

If there are no unpaid invoices, say: "All leverantörsfakturor for $MONTH are paid."
