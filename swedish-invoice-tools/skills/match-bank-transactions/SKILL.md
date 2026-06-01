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

### 3. Prior-Month Match (already sent to bookkeeping)
A payment often settles an invoice that was **booked in an earlier month** — the invoice
arrived and was classified/sent to the bookkeeper last month, but its `due_date` (or the
supplier's charge cycle) falls into this month, so the money only leaves now. This is the
normal cash-lag across a month boundary, **not** a missing document.

If the supplied invoice list includes carried-over invoices from a prior period (rows the
caller has tagged as already booked/sent), and an outgoing payment matches one of them by
exact or fuzzy criteria above, mark it `prior-month` and note the source file and the month
it was sent. **Do not mark it `unmatched`, and do not re-book it** — it is already in an
earlier month's verifikat.

Examples that recur every month: Google Workspace (invoice dated the last day of the service
month, charged ~4 days into the next month), and any leverantörsfaktura whose `due_date` is
in the following month (e.g. tax/Skatteverket, leasing).

### 4. No Match
The transaction matches no invoice in the list — current month or prior. Mark as `unmatched`.
This is a legitimate non-invoice payment (salary, owner transfer, bank fee, personal) or an
invoice genuinely missing from state.md (not yet classified). Before calling something
unmatched, confirm it is not a prior-month invoice already sent to bookkeeping.

## Output

For each match, state the bank row (date, amount, description), the matched invoice
(supplier, amount, due_date), and the confidence level.

Report four lists:
1. **Matched invoices** — current-month invoices; mark `payment_status = paid`
2. **Prior-month settlements** — payments matching an invoice already booked/sent in an
   earlier month; mark the bank row `prior-month` with the source file and sent-month.
   Mark that prior invoice `paid` in its own month's state (do not re-book it in this month).
3. **Unmatched bank transactions** — outgoing payments with no invoice match in any period
4. **Unpaid invoices** — invoices with no matching bank transaction

## Notes

- Do not modify amounts — match on exact numeric values
- Ignore incoming transactions (amount > 0) for invoice matching purposes
- If a single bank transaction matches multiple invoices (e.g., bulk payment), flag it
  for manual review rather than auto-assigning
- A month's statement normally contains a few `prior-month` settlements — invoices whose
  `due_date` landed in this month but were booked last month. Treat them as matched
  (already sent), never as unmatched/missing.
