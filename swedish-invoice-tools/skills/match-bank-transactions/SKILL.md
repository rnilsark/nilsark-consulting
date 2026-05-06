---
name: match-bank-transactions
description: Match Swedish bank statement transactions (SEB or Handelsbanken CSV export) against a list of invoices. Use this skill to identify which invoices have been paid and which transactions are unaccounted for.
---

# Matching Bank Transactions Against Invoices

## Supported Bank CSV Formats

### SEB
Expected columns: `Bokföringsdag`, `Valutadag`, `Belopp`, `Avsändare/mottagare`, `Transaktion`, `Saldo`

### Handelsbanken — two CSV types

Handelsbanken exports two distinct file types. Detect by inspecting the header row:

**Type A — Account transactions (main CSV)**
Key columns: `Bokföringsdag`, `Referens`, `Insättning/Uttag`, `Bokfört saldo`
- `Bokföringsdag` — settlement date
- `Referens` — short description (e.g. `hallon`, `CLAUDE.AI SUBS`, `INTERNET BET 1`)
- `Insättning/Uttag` — signed amount (negative = outgoing); may use comma as decimal separator and space as thousands separator

Rows where `Referens` starts with `INTERNET BET` are aggregate rows — the actual payees are in Type B files.

**Type B — Internet-payment detail CSVs**
Key columns: `Betaldatum`, `Mottagare`, `Belopp`, `Referens`
- `Betaldatum` — payment date
- `Mottagare` — payee name (full, readable)
- `Belopp` — unsigned amount (positive); may use space/period/comma formatting
- `Referens` — OCR number or payment reference

One Type B file is exported per date that contains Internet payments. They may all be provided at once or one at a time.

**Detection rule:** if the header contains `Insättning/Uttag` → Type A. If it contains `Mottagare` and `Betaldatum` → Type B.

If a header matches neither pattern, report the actual column names and ask for guidance before proceeding.

## Pre-processing

Before matching, merge the inputs:
1. Parse all provided CSVs and classify each as Type A or Type B.
2. From Type A, extract non-INTERNET BET outgoing rows as individual transactions.
3. From Type B files, extract each row as an individual outgoing transaction (already broken out per payee).
4. Discard the INTERNET BET aggregate rows from Type A — they are fully represented by the Type B rows.
5. Normalize amounts: strip spaces used as thousands separators, convert comma decimal to dot, parse as float.

## Matching Logic

Process only outgoing payments (Insättning/Uttag < 0 in Type A; all rows in Type B are outgoing).

For each outgoing transaction, attempt to match it to an unpaid invoice:

### 1. Exact Match (high confidence)
Both conditions must be true:
- `|amount|` equals the invoice `amount` (exact numeric match)
- The invoice `ocr_number` appears as a substring in the transaction's reference/description field (`Transaktion` for SEB, `Referens` for Handelsbanken Type B, `Referens` for Type A non-INTERNET BET rows)

Mark as `exact`.

### 2. Fuzzy Match (medium confidence)
Both conditions must be true:
- `|amount|` is within 1.00 SEK of the invoice `amount`
- The `supplier` name appears (case-insensitive, partial match) in the payee/description field (`Avsändare/mottagare` for SEB, `Mottagare` for Handelsbanken Type B, `Referens` for Type A)

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
