---
description: Match Swedish bank statement transactions (SEB or Handelsbanken CSV export) against a list of invoices. Use this skill to identify which invoices have been paid and which transactions are unaccounted for.
---

# Matching Bank Transactions Against Invoices

## Supported Bank CSV Formats

### SEB
Expected columns: `Bokföringsdag`, `Valutadag`, `Belopp`, `Avsändare/mottagare`, `Transaktion`, `Saldo`

### Handelsbanken
Expected columns may differ. Check the first row. Common column names: `Datum`, `Belopp`, `Motpart`, `Text`, `Saldo`. Adapt accordingly.

If the first row does not match either pattern, report the actual column names and ask for guidance before proceeding.

## Matching Logic

Process only outgoing payments: rows where `Belopp < 0` (money leaving the account).

For each outgoing transaction, attempt to match it to an unpaid invoice:

### 1. Exact Match (high confidence)
Both conditions must be true:
- `|Belopp|` equals the invoice `amount` (exact numeric match)
- The invoice `ocr_number` appears as a substring in the `Transaktion` column

Mark as `exact`.

### 2. Fuzzy Match (medium confidence)
Both conditions must be true:
- `|Belopp|` is within 1.00 SEK of the invoice `amount`
- The `supplier` name appears (case-insensitive, partial match) in `Avsändare/mottagare`

Mark as `fuzzy`. Flag for human review — fuzzy matches can be wrong.

### 3. No Match
The transaction has no matching invoice.

Mark as `unmatched`. This could be:
- A legitimate payment not in the invoice list (salary, tax, personal)
- An invoice missing from state.md (not yet classified)

## Output

For each match:
- State the bank row date, amount, description
- State the matched invoice (supplier, amount, due_date)
- State the confidence level

Report three lists:
1. **Matched invoices** — mark `payment_status = paid`
2. **Unmatched bank transactions** — outgoing payments with no invoice match (may need manual review)
3. **Unpaid invoices** — invoices with no matching bank transaction

## Notes

- Do not modify amounts — match on exact numeric values
- Ignore incoming transactions (Belopp > 0) for invoice matching purposes
- If a single bank transaction matches multiple invoices (e.g., bulk payment), flag it for manual review rather than auto-assigning
