# State File Schema Reference

Each month has a `state.md` file in Google Drive at:
```
DRIVE_ROOT_FOLDER_ID/YYYY-MM/.nilsark/state.md
```

This file is the single source of truth for all processing status. Every command downloads it, modifies it in memory, and uploads it back before finishing.

---

## Full Template

```markdown
# State: YYYY-MM

## Processed Gmail Messages
| message_id | date | from | subject | attachment_filename | status |
|------------|------|------|---------|-------------------|--------|

## Documents
| file | type | supplier | amount | currency | due_date | ocr_number | bank_account | vat_amount | drive_path | drive_file_id | payment_status | fortnox_sent |
|------|------|---------|--------|----------|---------|-----------|-------------|-----------|-----------|--------------|---------------|-------------|

## Bank Statement Transactions
| date | description | amount | currency | matched_to_file | match_confidence |
|------|-------------|--------|----------|----------------|-----------------|

## Month Summary
- Documents processed: 0
- Leverantörsfakturor: 0
- Kvitton: 0
- Skattekonto: 0
- Total VAT: 0 SEK
- Unpaid invoices: 0
- Month-close sent: no
- Month-close date:
```

---

## Table: Processed Gmail Messages

**Purpose:** Deduplication. Before downloading any attachment, the fetch command checks this table. If all rows for a `message_id` have status `classified` or `skipped — covered by companion receipt`, the message is skipped (fully processed). If any row has status `downloaded` or `error`, the message is re-processed — `downloaded` means an attachment was fetched but classification never completed.

| Column | Type | Description |
|--------|------|-------------|
| `message_id` | string | Gmail message ID (primary dedup key) |
| `date` | ISO 8601 date | Date the email was received |
| `from` | string | Sender email address |
| `subject` | string | Email subject line |
| `attachment_filename` | string | Filename of the downloaded attachment |
| `status` | enum | See values below |

**Status values:**
- `downloaded` — attachment saved to local staging (triggers re-processing on next run if not yet classified)
- `classified` — fetch-classify has successfully classified and uploaded this file
- `error` — download or processing failed; will be retried on next run
- `skipped — covered by companion receipt` — invoice suppressed because a matching kvitto from the same message was already classified; treated as fully processed for deduplication (a message_id with only this status is skipped on re-run)

---

## Table: Documents

**Purpose:** Tracks every accounting document with its extracted metadata and processing status.

| Column | Type | Description |
|--------|------|-------------|
| `file` | string | Local filename (e.g. `faktura-telia-2026-03-15.pdf`) |
| `type` | enum | Document type |
| `supplier` | string | Vendor/supplier name |
| `amount` | decimal | Total amount including VAT |
| `currency` | string | Currency code (almost always `SEK`) |
| `due_date` | ISO 8601 date | Förfallodatum — leverantörsfaktura only, blank for kvitto |
| `ocr_number` | string | OCR-nummer for bank payment — leverantörsfaktura only |
| `bank_account` | string | Bankgiro (XXXXXX-X) or plusgiro (XXXXX-X) |
| `vat_amount` | decimal | Moms in SEK |
| `drive_path` | string | Full path in Drive (e.g. `2026-03/Leverantörsfakturor/faktura.pdf`) |
| `drive_file_id` | string | Google Drive file ID — used by month-close to download without an extra lookup |
| `payment_status` | enum | Payment status |
| `fortnox_sent` | enum | Whether routed to Fortnox |

**Type values:**
- `leverantörsfaktura` — supplier invoice billed to NILSARK, has förfallodatum, requires manual payment
- `kvitto` — receipt for completed purchase, or invoice auto-charged to card; no manual payment needed
- `skattekonto` — tax payment instruction from Skatteverket (arbetsgivaravgift, prelskatt, F-skatt); filed in `Skattekonto/` subfolder
- `unknown` — could not be classified; requires manual review

**Payment status values:**
- `unpaid` — leverantörsfaktura not yet paid
- `paid` — matched to a bank transaction
- `overdue` — past förfallodatum and still unpaid
- `n/a` — kvitton (already paid at point of purchase)

**Fortnox sent values:**
- `no` — not yet routed to Fortnox
- `yes` — successfully forwarded to Fortnox

---

## Table: Bank Statement Transactions

**Purpose:** Records all bank transactions from the CSV export, with match results.

| Column | Type | Description |
|--------|------|-------------|
| `date` | ISO 8601 date | Bokföringsdag |
| `description` | string | Avsändare/mottagare or Transaktion from bank CSV |
| `amount` | decimal | Belopp (negative = outgoing payment) |
| `currency` | string | Currency (SEK) |
| `matched_to_file` | string | Filename of the matched document, or blank |
| `match_confidence` | enum | Quality of the match |

**Match confidence values:**
- `exact` — amount matches AND OCR number found in transaction text
- `fuzzy` — amount matches within 1 SEK AND supplier name partial-matches
- `unmatched` — no matching invoice found

---

## Month Summary

Free-form key-value section updated by each command:

```markdown
## Month Summary
- Documents processed: 12
- Leverantörsfakturor: 5
- Kvitton: 7
- Skattekonto: 1
- Total VAT: 4250 SEK
- Unpaid invoices: 2
- Month-close sent: no
- Month-close date:
```

`Month-close sent: yes` is the flag that prevents accidental re-running of `/month-close`.

---

## Notes

- **Concurrent access:** Do not run two commands simultaneously — the download-modify-upload cycle has no locking. Run commands sequentially.
- **State file location:** `state.md` lives in `YYYY-MM/.nilsark/state.md` — inside the `.nilsark` subfolder of the month folder, not in the month folder root.
- **First run:** If no `state.md` exists for the month, the fetch command creates one from this template.
