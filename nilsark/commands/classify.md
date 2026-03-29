---
description: "Classify PDFs in the local staging folder, extract accounting fields, upload to the correct Drive subfolder, and update state.md. Usage: /classify [YYYY-MM]"
argument-hint: YYYY-MM (defaults to current month)
allowed-tools: ["Read", "Bash"]
---

# Classify Accounting Documents

You are classifying accounting documents for NILSARK CONSULTING AB using the `classify-invoice` and `extract-invoice-fields` skills from the `swedish-invoice-tools` plugin.

## Step 1 — Read Config

```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
DRIVE_ROOT_FOLDER_ID=$(grep '^DRIVE_ROOT_FOLDER_ID=' ~/.nilsark-config.md | cut -d= -f2-)
```

## Step 2 — Determine Month

Use argument if provided, otherwise `date +%Y-%m`.

## Step 3 — Download state.md

> **Auth guard:** If any `gws` command in this step exits with a non-zero code and its output contains "auth", "token", "unauthenticated", "unauthorized", or "login", stop immediately and run `/nilsark:gws-auth`. After the user completes auth, retry from this step.

Follow the same download pattern as fetch-attachments (see `nilsark:accounting-state` skill). Load the current state.md from `$STAGING_DIR/.state/$MONTH-state.md`.

## Step 4 — Find Unclassified Files

List all PDF and image files in `$STAGING_DIR/$MONTH/`:
```bash
ls "$STAGING_DIR/$MONTH/"
```

Cross-reference against the Documents table in state.md. Files already present in the Documents table (matched by filename) should be skipped.

If there are no unclassified files, report "Nothing to classify for $MONTH." and stop.

## Step 5 — Classify Each File

For each unclassified file:

**a) Read the file.** Use the Read tool to read the PDF natively. Claude can read PDF content directly.

**b) Check for companion receipt (invoice+receipt pairs).**

Look up this file's message_id in the Processed Gmail Messages table. If that same message_id produced multiple attachment files, and one of those other files is already recorded in the Documents table as `kvitto`, then this file is likely the companion invoice for an already-filed receipt. Skip it and record it in state as `skipped — covered by companion receipt`. Do not upload to Drive.

**c) Classify** by reading `swedish-invoice-tools/skills/classify-invoice.md` and applying its decision tree to the document. Do not classify from your own reasoning — follow the skill's rules explicitly.

**d) Extract fields** using the `extract-invoice-fields` skill.

**e) Determine Drive target folder:**

- **kvitto** → `YYYY-MM/Verifikationer/`
- **leverantörsfaktura** → `YYYY-MM/Leverantörsfakturor/`
- **skattekonto** → `YYYY-MM/Skattekonto/`
- **unknown** → `YYYY-MM/Verifikationer/`

Find/create subfolders as needed:
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

Record the Drive path as appropriate:
- `YYYY-MM/Verifikationer/<filename>`
- `YYYY-MM/Leverantörsfakturor/<filename>`
- `YYYY-MM/Skattekonto/<filename>`

**g) Append row to Documents table** in state.md:
```
| <filename> | <type> | <supplier> | <amount> | <currency> | <due_date> | <ocr_number> | <bank_account> | <vat_amount> | <drive_path> | <payment_status> | no |
```

Set `payment_status`:
- `unpaid` for leverantörsfaktura and skattekonto
- `n/a` for kvitto
- `n/a` for unknown documents (set all financial fields to blank)

Also update the matching row in the Processed Gmail Messages table: change `status` from `downloaded` to `classified`.

## Step 6 — Update Month Summary

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

## Step 7 — Upload state.md

Upload the updated state.md back to Drive (see `nilsark:accounting-state` skill for the upload pattern).

## Step 8 — Print Summary

```
Classification complete for YYYY-MM:
  Leverantörsfakturor: N
  Kvitton: M
  Skattekonto: K
  Unknown (manual review needed): U

Documents needing review:
  - <filename>: <reason>
```
