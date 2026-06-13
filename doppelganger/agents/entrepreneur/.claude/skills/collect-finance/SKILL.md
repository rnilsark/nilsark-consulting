---
name: collect-finance
description: Collect all new finance documents for a month — list the inbox, dedup, download attachments, classify + extract fields, file to Drive, and match any bank statement against unpaid invoices. Self-contained leaf skill; invokes no other skill. Follows the State contract in the agent context for the state.md schema and Drive I/O. Stops before any payment, draft, or send.
---

# Collect finance (month)

Fetch, classify, and file every new finance attachment for the current month. All
classification/extraction/matching rules are inlined here. For the **state.md schema** and the
**Drive read/write cycle**, follow the *State contract* in your agent context (CLAUDE.md) — do not
invoke another skill.

Context you already have: `MONTH` (YYYY-MM), `DRIVE_ROOT`, `STAGING_DIR`. Derive `FIRST_DAY` =
`YYYY/MM/01`. Same auth guard as the State contract.

```bash
mkdir -p "$STAGING_DIR/$MONTH" "$STAGING_DIR/.state"
```

## Step 1 — Download state.md

Per the State contract: resolve the month folder → `.doppelganger` subfolder → download state.md
(capture `STATE_FILE_ID`); first run → create from the template.

## Step 2 — List inbox attachments

```bash
gws gmail users messages list --params '{"userId":"me","q":"has:attachment in:inbox after:'"$FIRST_DAY"'","maxResults":100}' --format json
```

## Step 3 — Per message-id: dedup + download

For each id:
- **Dedup** (per the contract): skip if all its rows are `classified`/`skipped — …`; reprocess if any
  `downloaded`/`error`.
- **Metadata:** `gws gmail users messages get --params '{"userId":"me","id":"<id>"}' --format json` →
  `from`, `date`, `subject`, attachment parts (parts with a non-empty `filename`, `mimeType` not
  `multipart/*`).
- **Download** each attachment (URL-safe base64 in `{"data":"..."}`; decode inline):
  ```bash
  gws gmail users messages attachments get \
    --params '{"userId":"me","messageId":"<id>","id":"<attachmentId>"}' --format json 2>/dev/null \
    | python3 -c "import sys,json,base64; sys.stdout.buffer.write(base64.urlsafe_b64decode(json.load(sys.stdin)['data']+'=='))" \
    > "$STAGING_DIR/$MONTH/<filename>"
  ```
  Original filename; append the message_id on a name collision. Write a Processed Gmail row
  `downloaded`, then upload state.md (persist dedup before classifying).

## Step 4 — Bank statement branch (detect first)

A file is a **bank statement** if it is a `.csv`, OR a `.pdf` (when read) showing a transaction list
with a running balance (`Bokfört saldo`), an account number, and a Handelsbanken header
(`Kontoutdrag`/`Kontohändelser`/`Transaktioner`). Contrast: an invoice/receipt has one supplier, one
total, usually an OCR/förfallodatum. If it is a statement, **match it** (don't classify as a document):

- Parse each row → `{date, description (Referens), amount (signed), reference/OCR}`. Normalize Swedish
  numbers (strip space thousands-separators, comma→dot).
- Invoice list: current-month `leverantörsfaktura`/`skattekonto` rows with `payment_status`
  `unpaid`/`overdue`, **plus** prior-month carry-over (download `<prev-YYYY-MM>/.doppelganger/state.md`
  if it exists; tag those as already-sent).
- Match each outgoing payment (amount < 0):
  - **exact** — `|amount|` equals invoice `amount` AND invoice `ocr_number` is a substring of the
    transaction reference.
  - **fuzzy** — `|amount|` within 1.00 SEK AND `supplier` appears (case-insensitive partial) in the
    payee/description. Flag for review.
  - **prior-month** — matches a carry-over invoice → mark `prior-month`, note source file + sent-month;
    set that invoice `paid` in the **previous** month's state.md and re-upload it. Do not re-book it.
  - **unmatched** — matches nothing in either period (salary, owner transfer, fee, or a missing invoice).
- Set current-month matches to `payment_status = paid`. Record every transaction in the Bank Statement
  Transactions table (dedup identical date+amount+description). Ignore incoming (amount > 0). A bulk
  payment matching multiple invoices → flag for review, don't auto-assign.
- Archive the statement to the `.doppelganger/` folder; this run reconciles the export.

## Step 5 — Document branch (classify + extract)

For each non-statement attachment, **Read** the PDF, then:

- **Companion-receipt rule:** if this message produced multiple attachments and another from the same
  message is already a `kvitto` in Documents, mark this row `skipped — covered by companion receipt`.
- **Kundfaktura pre-check (first):** if it is a **Självfaktura** (header says "Självfaktura", or
  Nilsark's VAT `SE559162955401` is the seller, or it records consulting hours billed on Nilsark's
  behalf) → `kundfaktura` (income).
- **Classify (first match wins):**
  1. Skatteverket + "Skattekonto" content (arbetsgivaravgift/preliminärskatt, OCR to bankgiro
     `5050-1055`) → `skattekonto`.
  2. Auto-charge language ("Beloppet dras från ditt registrerade kort", "Debiteras automatiskt", "Du
     debiteras automatiskt") → `kvitto` (even with a Fakturanummer).
  3. Labeled "Receipt"/"Amount paid", or shows a payment method (card/Swish/cash/"Betalt") → `kvitto`.
  4. Has **Förfallodatum** + manual payment details (OCR, Bankgiro/Plusgiro), no auto-charge →
     `leverantörsfaktura`.
  5. No Förfallodatum, shows completed payment → `kvitto`.
  6. Foreign/damaged/genuinely ambiguous → `unknown`.
- **Extract (blank if absent — never guess):** `supplier`; `amount` (total **incl. VAT** — "Att
  betala"/"Totalt inkl. moms"); `currency` (default `SEK`); `vat_amount` (sum all VAT rows). For
  leverantörsfaktura also: `due_date` (Förfallodatum, ISO), `ocr_number` (exact digits), `bank_account`
  (`BG XXXXXX-X`/`PG XXXXX-X`, keep prefix). `document_date` (own date, ISO; blank if unreadable).
- **Future-month skip:** `DOC_MONTH = document_date[0:7]` (else `MONTH`). `DOC_MONTH > MONTH` → don't
  upload/add a row; set the Processed Gmail row `skipped — future month`. `DOC_MONTH <= MONTH` → file
  in `MONTH`.
- **File it:** upload to the type's subfolder (contract folder map), capture `drive_file_id`, append
  the Documents row, set `payment_status` (`unpaid` for leverantörsfaktura/skattekonto, else `n/a`) and
  `fortnox_sent = no`, and flip the Processed Gmail row `downloaded` → `classified`.

## Step 6 — Persist + report

Recount the Month Summary, upload state.md. Report counts to the agent (collected by type, any
`unknown`, bank-match results). **No payments, no drafts, no send** — the agent handles the rest.
