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

Follow the same download pattern as fetch-attachments (see accounting-state skill). Load the current state.md from `$STAGING_DIR/.state/$MONTH-state.md`.

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

**b) Classify** using the `classify-invoice` skill rules:
- `leverantorsfaktura` — has Förfallodatum
- `kvitto` — no due date, shows completed payment
- `unknown` — ambiguous or unreadable

**c) Extract fields** using the `extract-invoice-fields` skill:
- All documents: `supplier`, `amount`, `currency`, `vat_amount`
- Leverantörsfaktura only: `due_date`, `ocr_number`, `bank_account`

**d) Determine Drive target folder:**

- **kvitto** → upload to `YYYY-MM/Verifikationer/`
- **leverantörsfaktura** → upload to `YYYY-MM/Verifikationer/Leverantörsfakturor/`

Find the subfolder ID:
```bash
# Find Verifikationer folder
gws drive files list --params '{"q": "name='\''Verifikationer'\'' and '\''<MONTH_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\''"}' --format json
```

If the folder does not exist, create it:
```bash
gws drive files create --json '{"name": "Verifikationer", "mimeType": "application/vnd.google-apps.folder", "parents": ["<MONTH_FOLDER_ID>"]}'
```

For leverantörsfaktura, also find/create `Leverantörsfakturor` inside `Verifikationer`:
```bash
gws drive files list --params '{"q": "name='\''Leverantörsfakturor'\'' and '\''<VERIFIKATIONER_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\''"}' --format json
```

**e) Upload to Drive:**
```bash
gws drive +upload "$STAGING_DIR/$MONTH/<filename>" --parent <TARGET_FOLDER_ID>
```

Record the Drive path as: `YYYY-MM/Verifikationer/<filename>` or `YYYY-MM/Verifikationer/Leverantörsfakturor/<filename>`

**f) Append row to Documents table** in state.md:
```
| <filename> | <type> | <supplier> | <amount> | <currency> | <due_date> | <ocr_number> | <bank_account> | <vat_amount> | <drive_path> | unpaid | no |
```

Set `payment_status`:
- `unpaid` for leverantörsfaktura
- `n/a` for kvitto
- `unknown` documents: set all financial fields to blank, `payment_status=n/a`, note in a comment

Also update the matching row in the Processed Gmail Messages table: change `status` from `downloaded` to `classified`.

## Step 6 — Update Month Summary

Recount all rows and update the Month Summary section.

## Step 7 — Upload state.md

Upload the updated state.md back to Drive.

## Step 8 — Print Summary

```
Classification complete for 2026-03:
  Leverantörsfakturor: N
  Kvitton: M
  Unknown (manual review needed): K

Documents needing review:
  - <filename>: <reason>
```
