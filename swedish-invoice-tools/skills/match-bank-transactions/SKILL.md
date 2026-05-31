---
name: match-bank-transactions
description: Match Handelsbanken bank statement transactions (CSV export or PDF statement) against a list of invoices. Use this skill to identify which invoices have been paid and which transactions are unaccounted for.
---

# Matching Bank Transactions Against Invoices

A Handelsbanken statement may be supplied as a **CSV export** or a **PDF statement**.
Both are machine-generated, high-quality tabular data — parse either into a single flat
list of transactions and run it through the Matching Logic. Each row is one transaction;
there is no aggregate/detail hierarchy to reconcile.

## Statement Formats

### CSV
Key columns: `Bokföringsdag`, `Referens`, `Insättning/Uttag`, `Bokfört saldo`
- `Bokföringsdag` — settlement date
- `Referens` — payee / description, and any OCR or payment reference
- `Insättning/Uttag` — signed amount (negative = outgoing); comma as decimal separator,
  space as thousands separator

If the header doesn't match, report the actual column names and ask before proceeding.

### PDF
A statement PDF (`Kontoutdrag`, `Kontohändelser`, `Transaktioner`, or similar). Read it
and extract each transaction row's date, payee/description, signed amount, and any
reference/OCR string into the same flat list the CSV produces.

## Pre-processing

Normalize amounts: strip spaces used as thousands separators, convert comma decimal to
dot, parse as float. Keep one row per transaction.

## Matching Logic

Process only outgoing payments (amount < 0). For each, attempt to match an unpaid invoice:

### 1. Exact Match (high confidence)
Both conditions must be true:
- `|amount|` equals the invoice `amount` (exact numeric match)
- The invoice `ocr_number` appears as a substring in the transaction's `Referens` /
  reference field

Mark as `exact`.

### 2. Fuzzy Match (medium confidence)
Both conditions must be true:
- `|amount|` is within 1.00 SEK of the invoice `amount`
- The `supplier` name appears (case-insensitive, partial match) in the transaction's
  payee/description field

Mark as `fuzzy`. Flag for human review — fuzzy matches can be wrong.

### 3. No Match
The transaction has no matching invoice. Mark as `unmatched`. This could be a legitimate
payment not in the invoice list (salary, tax, personal) or an invoice missing from
state.md (not yet classified).

## Output

For each match, state the bank row (date, amount, description), the matched invoice
(supplier, amount, due_date), and the confidence level.

Report three lists:
1. **Matched invoices** — mark `payment_status = paid`
2. **Unmatched bank transactions** — outgoing payments with no invoice match
3. **Unpaid invoices** — invoices with no matching bank transaction

## Notes

- Do not modify amounts — match on exact numeric values
- Ignore incoming transactions (amount > 0) for invoice matching purposes
- If a single bank transaction matches multiple invoices (e.g., bulk payment), flag it
  for manual review rather than auto-assigning
