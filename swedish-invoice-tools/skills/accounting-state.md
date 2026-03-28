---
description: Read and update a monthly accounting state.md file stored in Google Drive. Use this skill whenever a command needs to read processing status, check deduplication, or update document metadata.
---

# Reading and Writing the Accounting State File

## Location

The state file lives in Google Drive at:
```
DRIVE_ROOT_FOLDER_ID/YYYY-MM/state.md
```

## Download-Modify-Upload Cycle

Every command that reads or writes state follows this pattern:

1. **Download** state.md from Drive to local temp (`$STAGING_DIR/.state/YYYY-MM-state.md`)
   ```bash
   gws drive files list --params '{"q": "name='\''state.md'\'' and '\''<month_folder_id>'\'' in parents"}' --format json
   gws drive files get --params '{"fileId": "<state_file_id>", "alt": "media"}' -o $STAGING_DIR/.state/YYYY-MM-state.md
   ```

2. **Modify** in memory (parse → update → write to temp file)

3. **Upload** back to Drive (overwrite existing)
   ```bash
   gws drive +upload $STAGING_DIR/.state/YYYY-MM-state.md --parent <month_folder_id> --name state.md
   ```

**Important:** Do not leave state.md in an inconsistent state. Always upload after modifying. If the upload fails, report the error — do not silently discard changes.

## Finding the Month Folder ID

```bash
gws drive files list --params '{"q": "name='\''YYYY-MM'\'' and '\''<DRIVE_ROOT_FOLDER_ID>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\''"}' --format json
```

If the folder doesn't exist yet (first run for the month), create it:
```bash
gws drive files create --json '{"name": "YYYY-MM", "mimeType": "application/vnd.google-apps.folder", "parents": ["<DRIVE_ROOT_FOLDER_ID>"]}'
```

## Parsing Tables

State.md uses markdown tables. Parse each row by:
1. Splitting on `|`
2. Trimming whitespace from each cell
3. Skipping the header row and the separator row (`|---|---|...`)
4. Treating blank cells as empty string / null

## Deduplication Check

Before downloading a Gmail attachment, check the Processed Gmail Messages table:
```
If message_id exists in the table AND status != 'error' → skip this message
```

## Appending Rows

To add a new row to a table, append it after the last data row (before the next `##` section or end of file). Maintain column alignment for readability.

Example — appending to Documents table:
```markdown
| faktura-telia-2026-03.pdf | leverantorsfaktura | Telia Sverige AB | 1250.00 | SEK | 2026-04-15 | 1234567890 | BG 123456-7 | 250.00 | 2026-03/Verifikationer/Leverantörsfakturor/faktura-telia-2026-03.pdf | unpaid | no |
```

## Updating Existing Rows

To update a field in an existing row, find the row by the `file` or `message_id` column and replace the target field value in place. Do not change other fields in the same row.

## Month Summary

Update the Month Summary section counts at the end of each command run:
- Re-count rows by type to update `Leverantörsfakturor` and `Kvitton`
- Re-count `payment_status=unpaid OR overdue` rows for `Unpaid invoices`
- Update `Documents processed` to total Documents table rows
- Sum all `vat_amount` values for `Total VAT`

## First Run (no state.md exists)

Create a blank state.md from the template (see docs/state-schema.md) and upload it to the Drive month folder before proceeding.
