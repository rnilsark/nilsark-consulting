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

Derive the first and last day for Gmail search:
- YEAR and MONTH_NUM from MONTH (e.g. 2026 and 03)
- FIRST_DAY: YYYY/MM/01
- LAST_DAY: first day of NEXT month (for Gmail's `before:` which is exclusive)

## Step 3 — Create Local Staging Directory

```bash
mkdir -p "$STAGING_DIR/$MONTH"
mkdir -p "$STAGING_DIR/.state"
```

## Step 4 — Download or Initialize state.md

**Important:** Always run the Drive queries below fresh — never reuse folder IDs or file IDs from a previous conversation turn or prior run.

> **Auth guard:** If any `gws` command below exits with a non-zero code and its output contains "auth", "token", "unauthenticated", "unauthorized", or "login", stop immediately and run `/nilsark:gws-auth`. After the user completes auth, retry from this step.

Find the month folder in Drive:
```bash
gws drive files list --params '{"q": "name='\'''"$MONTH"'\'' and '\'''"$DRIVE_ROOT_FOLDER_ID"'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json
```

If the month folder does not exist yet, create it:
```bash
gws drive files create --json '{"name": "'"$MONTH"'", "mimeType": "application/vnd.google-apps.folder", "parents": ["'"$DRIVE_ROOT_FOLDER_ID"'"]}'
```

Find or create the `.nilsark` subfolder within the month folder:
```bash
gws drive files list --params '{"q": "name='\''.nilsark'\'' and '\''<MONTH_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json
# If not found:
gws drive files create --json '{"name": ".nilsark", "mimeType": "application/vnd.google-apps.folder", "parents": ["<MONTH_FOLDER_ID>"]}'
```

Find and download state.md from the `.nilsark` folder. Capture the file ID — you will need it for the upload step:
```bash
STATE_FILE_ID=$(gws drive files list --params '{"q": "name='\''state.md'\'' and '\''<NILSARK_FOLDER_ID>'\'' in parents and trashed=false"}' --format json | jq -r '.files[0].id // empty')
cd "$STAGING_DIR/.state" && gws drive files get --params '{"fileId": "'$STATE_FILE_ID'", "alt": "media"}' -o "$MONTH-state.md"
```

If state.md does not exist yet, create it from the template defined in the `nilsark:accounting-state` skill (see First Run section).

## Step 5 — Parse Existing Message IDs

Read the local state.md and extract all `message_id` values from the Processed Gmail Messages table. These will be skipped.

## Step 6 — Search Gmail for Attachments

```bash
gws gmail users messages list --params '{"userId": "me", "q": "has:attachment in:inbox after:'"$FIRST_DAY"' before:'"$LAST_DAY"'", "maxResults": 100}' --format json
```

This returns a list of message IDs.

## Step 7 — Download New Attachments

Initialize an empty list: `NEWLY_DOWNLOADED=()`.

For each message ID returned:

**a) Check deduplication:** If this message_id exists in state.md with status other than `error`, skip it and increment the skipped counter.

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

**d) Update state.md:** Append a row to the Processed Gmail Messages table:
```
| <message_id> | <date> | <from> | <subject> | <filename> | downloaded |
```

If any step (b, c) fails, append the row with status `error` and continue to the next message. Do not abort.

## Step 8 — Classify New Files

For each filename in `NEWLY_DOWNLOADED`: skip it if it is already present in the Documents table (matched by filename). If no files remain after this check, skip to Step 9.

**a) Read the file.** Use the Read tool to open the PDF.

**b) Check for companion receipt (invoice+receipt pairs).**

Look up this file's message_id by finding its row in the Processed Gmail Messages table (match by filename). If that same message_id produced multiple attachments and another is already in the Documents table as `kvitto`, update this row's status to `skipped — covered by companion receipt`, skip steps c–g, and continue to the next file. Do not upload to Drive.

**c) Classify** by reading `swedish-invoice-tools/skills/classify-invoice.md` and applying its decision tree to the document. Do not classify from your own reasoning — follow the skill's rules explicitly.

**d) Extract fields** using the `extract-invoice-fields` skill.

**e) Determine Drive target folder:**

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

**f) Upload to Drive:**
```bash
gws drive +upload "$STAGING_DIR/$MONTH/<filename>" --parent <TARGET_FOLDER_ID>
```

Record the Drive path (e.g. `2026-03/Verifikationer/<filename>`).

**g) Append row to Documents table** in state.md:
```
| <filename> | <type> | <supplier> | <amount> | <currency> | <due_date> | <ocr_number> | <bank_account> | <vat_amount> | <drive_path> | <payment_status> | no |
```

Set `payment_status`:
- `unpaid` for leverantörsfaktura and skattekonto
- `n/a` for kvitto
- `n/a` for unknown documents (leave all financial fields blank)

Also update the matching row in the Processed Gmail Messages table (match by message_id from step b): if the current status is `downloaded`, change it to `classified`. Skip the update entirely for rows with status `error`.

## Step 9 — Update Month Summary

Recount all rows and update the Month Summary section:

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

Upload the modified state.md back to Drive: — update in-place if the file already exists, otherwise create:
- If `$STATE_FILE_ID` is set (normal case):
  ```bash
  gws drive files update --params '{"fileId": "'$STATE_FILE_ID'"}' \
    --upload "$STAGING_DIR/.state/$MONTH-state.md" --upload-content-type text/markdown
  ```
- If `$STATE_FILE_ID` is empty (first run — no state.md in Drive yet):
  ```bash
  cd "$STAGING_DIR/.state" && gws drive +upload "$MONTH-state.md" --parent <NILSARK_FOLDER_ID> --name state.md
  ```

## Step 11 — Print Summary

```
Fetch + classify complete for 2026-03:
  New messages fetched: N  (M attachments)
  Messages skipped (already processed): K
  Classified — leverantörsfakturor: A
  Classified — kvitton: B
  Classified — skattekonto: C
  Unknown (manual review needed): U
  Errors: E (check state.md for details)

Files saved to: $STAGING_DIR/2026-03/
```

If U > 0, list the unknown files and the reason classification was uncertain:
```
Documents needing review:
  - <filename>: <reason>
```
