---
description: "Fetch and classify Gmail attachments for the current (or specified) month, uploading to Drive in a single pass. Safe to run multiple times. Usage: /fetch-classify [YYYY-MM]"
argument-hint: YYYY-MM (defaults to current month)
allowed-tools: ["Read", "Bash"]
---

# Fetch and Classify Attachments

You are fetching and classifying email attachments for NILSARK CONSULTING AB's monthly accounting.

## Step 1 — Read Config

Read `~/.nilsark-config.md` and extract these values using Bash:
```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
DRIVE_ROOT_FOLDER_ID=$(grep '^DRIVE_ROOT_FOLDER_ID=' ~/.nilsark-config.md | cut -d= -f2-)
```

If the config file does not exist, stop and tell the user:
> Config not found. Copy `config.template.md` to `~/.nilsark-config.md` and fill in your values. See docs/setup.md for instructions.

## Step 2 — Determine Month

If the user provided an argument (e.g. `2026-03`), use that as MONTH.
Otherwise use the current month:
```bash
MONTH=$(date +%Y-%m)
```

Derive the first day for Gmail search:
- YEAR and MONTH_NUM from MONTH (e.g. 2026 and 03)
- FIRST_DAY: YYYY/MM/01

Initialize run-level counters:
```bash
FUTURE_MONTH_SKIP_COUNT=0
declare -A CROSS_MONTH_FILINGS  # map of DOC_MONTH → count
```

## Step 3 — Create Local Staging Directory

```bash
mkdir -p "$STAGING_DIR/$MONTH"
mkdir -p "$STAGING_DIR/.state"
```

## Step 4 — Download or Initialize state.md

**Important:** Always run the Drive queries below fresh — never reuse folder IDs or file IDs from a previous conversation turn or prior run.

> **Auth guard:** If any `gws` command in this command exits with a non-zero code and its output contains "auth", "token", "unauthenticated", "unauthorized", or "login", stop immediately and run `/nilsark:gws-auth`. After the user completes auth, retry from this step. This guard applies to all gws calls in all subsequent steps, not just Step 4.

Find the month folder in Drive:
```bash
gws drive files list --params '{"q": "name='\'''"$MONTH"'\'' and '\'''"$DRIVE_ROOT_FOLDER_ID"'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json
```

If the month folder does not exist yet, create it:
```bash
gws drive files create --json '{"name": "'"$MONTH"'", "mimeType": "application/vnd.google-apps.folder", "parents": ["'"$DRIVE_ROOT_FOLDER_ID"'"]}'
```

Find or create the `.nilsark` subfolder within the month folder. Assign to `NILSARK_FOLDER_ID`:
```bash
NILSARK_LIST=$(gws drive files list --params '{"q": "name='\''.nilsark'\'' and '\''<MONTH_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json)
NILSARK_FOLDER_ID=$(echo "$NILSARK_LIST" | jq -r '.files[0].id // empty')
# If not found (list succeeded but NILSARK_FOLDER_ID is empty), create it:
if [ -z "$NILSARK_FOLDER_ID" ]; then
  NILSARK_FOLDER_ID=$(gws drive files create --json '{"name": ".nilsark", "mimeType": "application/vnd.google-apps.folder", "parents": ["<MONTH_FOLDER_ID>"]}' --format json | jq -r '.id')
fi
```

Find state.md in the `.nilsark` folder and capture its file ID:
```bash
STATE_LIST=$(gws drive files list --params '{"q": "name='\''state.md'\'' and '\''<NILSARK_FOLDER_ID>'\'' in parents and trashed=false"}' --format json)
STATE_FILE_ID=$(echo "$STATE_LIST" | jq -r '.files[0].id // empty')
```

If the `files list` command itself fails (non-zero exit, or output is not valid JSON), stop immediately — do not fall through to template creation, as this indicates an auth or network error, not a genuine first run.

If `$STATE_FILE_ID` is non-empty, download it:
```bash
cd "$STAGING_DIR/.state" && gws drive files get --params '{"fileId": "'$STATE_FILE_ID'", "alt": "media"}' -o "$MONTH-state.md"
```

If `$STATE_FILE_ID` is empty (state.md not found in Drive — genuine first run), create it from the template defined in the `nilsark:accounting-state` skill (see First Run section). Do not issue a `files get` with an empty ID.

## Step 5 — Parse Existing Message IDs

Read the local state.md and extract all `message_id` values from the Processed Gmail Messages table. These will be skipped.

## Step 6 — Search Gmail for Attachments

```bash
gws gmail users messages list --params '{"userId": "me", "q": "has:attachment in:inbox after:'"$FIRST_DAY"'", "maxResults": 100}' --format json
```

This returns a list of message IDs. The search has no end-date cutoff. Deduplication (Step 7a) is the primary guard against re-processing already-classified messages.

## Step 7 — Download New Attachments

Initialize an empty list: `NEWLY_DOWNLOADED=()`.

For each message ID returned:

**a) Check deduplication:** If this message_id exists in state.md AND **all** rows for this message_id have status `classified`, skip it and increment the skipped counter. If any row has status `downloaded` or `error`, process the message again — `downloaded` means the attachment was fetched but classification was never completed. (Rows with status `skipped — covered by companion receipt` count as classified for deduplication purposes.)

**b) Get message metadata:**
```bash
gws gmail users messages get --params '{"userId": "me", "id": "'"$MESSAGE_ID"'"}' --format json
```

Extract: sender (from), date, subject, and the list of attachments (parts where `filename` is non-empty and `mimeType` is not `multipart/*`).

**c) Download each attachment:**

Note: `gws` returns attachment data as URL-safe base64 JSON (`{"data": "..."}`); the `-o` flag saves the raw JSON, not the decoded binary. Decode inline:

```bash
gws gmail users messages attachments get \
  --params '{"userId": "me", "messageId": "'"$MESSAGE_ID"'", "id": "'"$ATTACHMENT_ID"'"}' \
  --format json 2>/dev/null \
  | python3 -c "import sys,json,base64; sys.stdout.buffer.write(base64.urlsafe_b64decode(json.load(sys.stdin)['data']+'=='))" \
  > "$STAGING_DIR/$MONTH/<filename>"
```

Use the original filename from the message. If two files have the same name, append the message_id as suffix. Add each successfully downloaded filename to `NEWLY_DOWNLOADED`.

**d) Update state.md:** Write a row to the Processed Gmail Messages table. If a row for this exact (message_id, filename) combination already exists, update it in-place. If no such row exists, append a new one:
```
| <message_id> | <date> | <from> | <subject> | <filename> | downloaded |
```

If any step (b, c) fails, write (or update) the row with status `error` and continue to the next message. Do not abort.

## Step 7b — Persist Download Progress

Upload the current state.md to Drive immediately after the download loop, before classification begins. This ensures deduplication rows are persisted even if classification fails later.

- If `$STATE_FILE_ID` is set (normal case): use `gws drive files update`
- If `$STATE_FILE_ID` is empty (first run):
  ```bash
  UPLOAD_RESULT=$(cd "$STAGING_DIR/.state" && gws drive +upload "$MONTH-state.md" --parent "$NILSARK_FOLDER_ID" --name state.md --format json)
  UPLOAD_EXIT=$?
  STATE_FILE_ID=$(echo "$UPLOAD_RESULT" | jq -r '.id // empty')
  ```

Capture `UPLOAD_EXIT=$?` (shown above for first run; for `files update` in the normal case, capture the exit code the same way). If non-zero, stop and report the error — do not proceed to classification with unpersisted state.

## Step 8 — Classify New Files

For each filename in `NEWLY_DOWNLOADED`: skip it if it is already present in the Documents table (matched by filename). If no files remain after this check, skip to Step 9.

**a) Read the file.** Use the Read tool to open the PDF.

**b) Check for companion receipt (invoice+receipt pairs).**

Look up this file's message_id by finding its row in the Processed Gmail Messages table (match by filename). If that same message_id produced multiple attachments and another is already in the Documents table as `kvitto`, update this row's status to `skipped — covered by companion receipt`, skip steps c–g, and continue to the next file. Do not upload to Drive.

Note: this check is one-directional — it fires only when the kvitto was processed before the invoice. If the invoice appears first in `NEWLY_DOWNLOADED`, the invoice is classified normally; the companion kvitto is then also classified normally when its turn comes. Both end up in state.md in their respective folders, which is correct behavior.

**c) Classify** by reading `swedish-invoice-tools/skills/classify-invoice.md` and applying its decision tree to the document. Do not classify from your own reasoning — follow the skill's rules explicitly.

**d) Extract fields** using the `extract-invoice-fields` skill.

**d2) Extract `document_date`.**

From the PDF/image already read in step a, extract the document's own date:
- **leverantörsfaktura**: invoice date (Fakturadatum / Invoice date) — NOT the due date (Förfallodatum)
- **kvitto**: purchase/transaction date on the receipt; for auto-charged subscriptions, the charge date
- **skattekonto**: statement date or payment period start date from the Skatteverket notice
- **unknown**: any readable date on the document

Normalize to `YYYY-MM-DD`. If unreadable or absent, set `document_date = ""` (empty).

**d3) Determine DOC_MONTH and routing case.**

```
If document_date is non-empty:
    DOC_MONTH = document_date[0:7]  (e.g. "2026-03")
Else:
    DOC_MONTH = $MONTH  (fall back — treat as current month)
```

Compare DOC_MONTH to MONTH (string comparison on YYYY-MM is correct):

- **Case A — DOC_MONTH == MONTH**: proceed with steps e–g below.
- **Case B — DOC_MONTH > MONTH (future-dated)**: do NOT upload or add a Documents row. Update the Processed Gmail Messages row for this (message_id, filename) to `skipped — future month`. Increment `FUTURE_MONTH_SKIP_COUNT`. Continue to next file.
- **Case C — DOC_MONTH < MONTH (late-arriving, prior month)**: skip step e and proceed to step e2 below.

**e) Determine Drive target folder (Case A — same month):**

- **kvitto** → `YYYY-MM/Verifikationer/`
- **leverantörsfaktura** → `YYYY-MM/Leverantörsfakturor/`
- **skattekonto** → `YYYY-MM/Skattekonto/`
- **unknown** → `YYYY-MM/Verifikationer/`

Find/create the target subfolder under the month folder as needed:
```bash
# Find Verifikationer folder (for kvitto + unknown)
gws drive files list --params '{"q": "name='\''Verifikationer'\'' and '\''<MONTH_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json

# If not found, create it
gws drive files create --json '{"name": "Verifikationer", "mimeType": "application/vnd.google-apps.folder", "parents": ["<MONTH_FOLDER_ID>"]}'

# Find/create Leverantörsfakturor directly under month folder
gws drive files list --params '{"q": "name='\''Leverantörsfakturor'\'' and '\''<MONTH_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json

# Find/create Skattekonto directly under month folder
gws drive files list --params '{"q": "name='\''Skattekonto'\'' and '\''<MONTH_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json
```

Proceed to step f.

**e2) Cross-month Drive setup (Case C only).**

Resolve `DOC_MONTH`'s Drive folder, `.nilsark` subfolder, type subfolder, and state.md — using the same patterns as Step 4, but parameterized with `DOC_MONTH` instead of `$MONTH`. Use variables `DOC_MONTH_FOLDER_ID`, `DOC_NILSARK_FOLDER_ID`, `DOC_STATE_FILE_ID`:

```bash
# Find or create DOC_MONTH folder
DOC_MONTH_FOLDER_ID=$(gws drive files list --params '{"q": "name='\'''"$DOC_MONTH"'\'' and '\'''"$DRIVE_ROOT_FOLDER_ID"'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json | jq -r '.files[0].id // empty')
[ -z "$DOC_MONTH_FOLDER_ID" ] && DOC_MONTH_FOLDER_ID=$(gws drive files create --json '{"name": "'"$DOC_MONTH"'", "mimeType": "application/vnd.google-apps.folder", "parents": ["'"$DRIVE_ROOT_FOLDER_ID"'"]}' --format json | jq -r '.id')

# Find or create .nilsark subfolder
DOC_NILSARK_LIST=$(gws drive files list --params '{"q": "name='\''.nilsark'\'' and '\'''"$DOC_MONTH_FOLDER_ID"'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json)
DOC_NILSARK_FOLDER_ID=$(echo "$DOC_NILSARK_LIST" | jq -r '.files[0].id // empty')
[ -z "$DOC_NILSARK_FOLDER_ID" ] && DOC_NILSARK_FOLDER_ID=$(gws drive files create --json '{"name": ".nilsark", "mimeType": "application/vnd.google-apps.folder", "parents": ["'"$DOC_MONTH_FOLDER_ID"'"]}' --format json | jq -r '.id')

# Find and download DOC_MONTH state.md (only if not already open this run)
DOC_STATE_LIST=$(gws drive files list --params '{"q": "name='\''state.md'\'' and '\'''"$DOC_NILSARK_FOLDER_ID"'\'' in parents and trashed=false"}' --format json)
DOC_STATE_FILE_ID=$(echo "$DOC_STATE_LIST" | jq -r '.files[0].id // empty')
```

If `files list` fails (non-zero exit or non-JSON output), stop — do not fall through.

If `DOC_STATE_FILE_ID` is non-empty and this `DOC_MONTH` has not been opened yet this run, download it:
```bash
cd "$STAGING_DIR/.state" && gws drive files get --params '{"fileId": "'$DOC_STATE_FILE_ID'", "alt": "media"}' -o "$DOC_MONTH-state.md"
```

If `DOC_STATE_FILE_ID` is empty (genuine first run for DOC_MONTH), create `$DOC_MONTH-state.md` from the template.

If the same DOC_MONTH appears for a second document in this run, reuse the already-downloaded (and in-memory modified) `$DOC_MONTH-state.md` without re-downloading. Reuse the previously captured `DOC_MONTH_FOLDER_ID`, `DOC_NILSARK_FOLDER_ID`, and `DOC_STATE_FILE_ID`.

Find/create the type subfolder under `DOC_MONTH_FOLDER_ID` (same logic as step e, substituting `DOC_MONTH_FOLDER_ID` for `MONTH_FOLDER_ID`). Assign to `TARGET_FOLDER_ID`.

**f) Upload to Drive and capture file ID:**
```bash
UPLOAD_RESULT=$(gws drive +upload "$STAGING_DIR/$MONTH/<filename>" --parent <TARGET_FOLDER_ID> --format json)
UPLOAD_EXIT=$?
DRIVE_FILE_ID=$(echo "$UPLOAD_RESULT" | jq -r '.id // empty')
```

For Case C, `TARGET_FOLDER_ID` is the type subfolder resolved in step e2. Record `drive_path` as `DOC_MONTH/<subfolder>/<filename>`.

If `$UPLOAD_EXIT` is non-zero (upload failed): log `drive_file_id = upload-failed` in the Documents table, set `payment_status` as normal, and include this file in the Step 11 summary under a "Upload errors (manual re-upload needed)" section. Do not abort — continue to the next file.

If `$UPLOAD_EXIT` is zero but `$DRIVE_FILE_ID` is empty (unexpected): leave `drive_file_id` blank — month-close will fall back to a Drive files list lookup.

**g) Append row to Documents table and update state:**

For **Case A**: append to `$MONTH-state.md`:
```
| <filename> | <type> | <supplier> | <amount> | <currency> | <due_date> | <document_date> | <ocr_number> | <bank_account> | <vat_amount> | <drive_path> | <drive_file_id> | <payment_status> | no |
```

For **Case C**: append to `$DOC_MONTH-state.md` (same format). Then update `$DOC_MONTH-state.md`'s Month Summary (re-count all rows). Then immediately upload `$DOC_MONTH-state.md` to Drive:
```bash
# Update in-place if DOC_STATE_FILE_ID is set:
gws drive files update --params '{"fileId": "'$DOC_STATE_FILE_ID'"}' \
  --upload "$STAGING_DIR/.state/$DOC_MONTH-state.md" --upload-content-type text/markdown

# If DOC_STATE_FILE_ID is empty (first document for this DOC_MONTH, first-run):
DOC_UPLOAD=$(cd "$STAGING_DIR/.state" && gws drive +upload "$DOC_MONTH-state.md" --parent "$DOC_NILSARK_FOLDER_ID" --name state.md --format json)
DOC_STATE_FILE_ID=$(echo "$DOC_UPLOAD" | jq -r '.id // empty')
```

Record `CROSS_MONTH_FILINGS[$DOC_MONTH]=$((${CROSS_MONTH_FILINGS[$DOC_MONTH]:-0} + 1))`.

Set `payment_status`:
- `unpaid` for leverantörsfaktura and skattekonto
- `n/a` for kvitto
- `n/a` for unknown documents (leave all financial fields blank)

In **all cases (A and C)**: update the matching row in the **primary** `$MONTH-state.md` Processed Gmail Messages table (match by message_id from step b): if the current status is `downloaded`, change it to `classified`. Skip the update entirely for rows with status `error`.

## Step 9 — Update Month Summary

Recount all rows in `$MONTH-state.md` and update its Month Summary section. `Documents processed` counts only documents filed to `$MONTH` (Case A). Cross-month documents (Case C) were already counted in their respective state files during step 8g.

```
- Documents processed: N
- Leverantörsfakturor: N
- Kvitton: N
- Skattekonto: N
- Total VAT: N SEK
- Unpaid invoices: N  (leverantörsfakturor + skattekonto with payment_status=unpaid)
- Month-close sent: no
- Month-close date:
```

## Step 10 — Upload state.md

Upload the modified `$MONTH-state.md` back to Drive. By this point `$STATE_FILE_ID` is always set — Step 7b ensures it is populated even on a first run. Always use the update path:
```bash
gws drive files update --params '{"fileId": "'$STATE_FILE_ID'"}' \
  --upload "$STAGING_DIR/.state/$MONTH-state.md" --upload-content-type text/markdown
```

Cross-month state files were already uploaded inline during step 8g.

## Step 11 — Print Summary

```
Fetch + classify complete for 2026-03:
  New messages fetched: N  (M attachments)
  Messages skipped (already processed): K
  Skipped — future month (picked up by later run): F

Filed to 2026-03:
  Classified — leverantörsfakturor: A
  Classified — kvitton: B
  Classified — skattekonto: C
  Unknown (manual review needed): U

Cross-month filings:
  → 2026-02: X documents
  (or "None" if no cross-month filings this run)

Download/classification errors: E (check state.md for details)

Files saved to: $STAGING_DIR/2026-03/
```

If U > 0, list the unknown files and the reason classification was uncertain:
```
Documents needing review:
  - <filename>: <reason>
```

If any Drive uploads failed (Step 8f), add:
```
Upload errors (manual re-upload needed): F
  - <filename>: upload failed — file is at $STAGING_DIR/2026-03/<filename>, re-upload to Drive manually
```
