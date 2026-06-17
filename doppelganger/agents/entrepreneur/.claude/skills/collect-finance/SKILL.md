---
name: collect-finance
description: Collect all new finance documents for a month — list the inbox, dedup, download attachments, classify + extract fields, file to Drive, and match any bank statement against unpaid invoices. Self-contained leaf skill; invokes no other skill. Follows the State contract in the agent context for the state.md schema and Drive I/O. Stops before any payment, draft, or send.
---

# Collect finance (period)

Fetch, classify, and file new finance attachments for the period `MONTH` the agent gives you,
**filing each document into the month its own `document_date` belongs to** (so a late June invoice
that arrives in July lands in June). All classification/extraction/matching rules are inlined here.
For the **state.md schema** and the **Drive read/write cycle**, follow the *State contract* in your
agent context (CLAUDE.md) — do not invoke another skill.

Context the agent gives you: `MONTH` (the period being collected, YYYY-MM); the **open-period list**
(the other months in this run); whether `MONTH` is the **OLDEST** open period; plus `DRIVE_ROOT` and
`STAGING_DIR`. Derive `FIRST_DAY` = `YYYY/MM/01` of `MONTH`. Same auth guard as the State contract.
The agent runs the periods oldest-first, so when this pass runs, earlier open periods are already done.

```bash
mkdir -p "$STAGING_DIR/$MONTH" "$STAGING_DIR/.state"
```

## Step 1 — Download state.md

Per the State contract: resolve the month folder → `.doppelganger` subfolder → then fetch with the
checksum guard:

```bash
STATE_LIST=$(gws drive files list --params '{"q": "name='\''state.md'\'' and '\'''"$DOPPELGANGER_FOLDER_ID"'\'' in parents and trashed=false", "fields": "files(id,name,headRevisionId,md5Checksum)"}' --format json)
STATE_FILE_ID=$(echo "$STATE_LIST" | jq -r '.files[0].id // empty')
STATE_HEAD_REV=$(echo "$STATE_LIST" | jq -r '.files[0].headRevisionId // empty')
STATE_MD5=$(echo "$STATE_LIST" | jq -r '.files[0].md5Checksum // empty')

LOCAL_MD5=$(md5sum "$STAGING_DIR/.state/$MONTH-state.md" 2>/dev/null | awk '{print $1}')
if [ -n "$STATE_FILE_ID" ] && [ "$LOCAL_MD5" != "$STATE_MD5" ]; then
  cd "$STAGING_DIR/.state" && gws drive files get --params '{"fileId": "'$STATE_FILE_ID'", "alt": "media"}' -o "$MONTH-state.md"
fi
```

Empty `STATE_FILE_ID` = first run → create from the template. Store `STATE_HEAD_REV` for the upload
guard. When uploading state.md at the end of this skill, apply the same collision guard as in the
State contract: re-fetch `headRevisionId`, compare to `STATE_HEAD_REV`, and flag (do not overwrite)
on a mismatch.

## Step 2 — List inbox attachments

```bash
gws gmail users messages list --params '{"userId":"me","q":"has:attachment in:inbox after:'"$FIRST_DAY"'","maxResults":100}' --format json
```

## Step 3 — Per message-id: dedup + download

For each id:
- **Dedup (across open periods):** skip the message if it is already `classified`/`skipped — …` in
  `MONTH`'s state.md **or in any other open period's state.md** — reprocess only if its rows are
  `downloaded`/`error`. (A bank statement sits in several periods' `after:` windows; the cross-period
  check ensures the earlier pass that already handled it isn't repeated here.)
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

- **Period routing:** a statement belongs to the month of its transactions, not to whichever pass
  first sees it. Determine its month from the transaction dates. If that month `!= MONTH`, **skip it
  in this pass** (the matching pass owns it; cross-period dedup prevents double-processing) — unless
  `MONTH` is the OLDEST open period and the statement predates the window, in which case process it
  here. Otherwise continue:
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
- Archive the statement to `MONTH`'s `.doppelganger/` folder; this reconciles `MONTH`'s export.

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
- **Route by document_date — does this doc belong to `MONTH`?** `DOC_MONTH = document_date[0:7]`
  (else `MONTH`). File it in `MONTH` **only if** `DOC_MONTH == MONTH`, **or** `MONTH` is the OLDEST
  open period and `DOC_MONTH < MONTH` (a doc predating the whole window — file here and add the
  anomaly flag `⚠ sen post (daterad <DOC_MONTH>)`). Otherwise **skip in this pass**:
  - `DOC_MONTH > MONTH` (a later open period, or genuinely future) → set the Processed Gmail row
    `skipped — future month`; the month it belongs to files it (a later pass this run, or a future run).
  - `DOC_MONTH < MONTH` and `MONTH` is **not** the oldest → an earlier open period already owns it
    (its pass ran first this run); leave it — the cross-period dedup keeps it from being double-filed.
- **File it (when it belongs to `MONTH`):** upload to the type's subfolder (contract folder map),
  capture `drive_file_id`, append the Documents row, set `payment_status` (`unpaid` for
  leverantörsfaktura/skattekonto, else `n/a`) and `fortnox_sent = no`, and flip the Processed Gmail
  row `downloaded` → `classified`.

## Step 6 — Persist + report

Recount the Month Summary, upload state.md (apply collision guard as specified in Step 1). Report
counts to the agent (collected by type, any `unknown`, bank-match results). **No payments, no drafts,
no send** — the agent handles the rest.
