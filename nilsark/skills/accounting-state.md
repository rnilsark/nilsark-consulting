---
description: Read and update a monthly accounting state.md file stored in Google Drive. Use this skill whenever a command needs to read processing status, check deduplication, or update document metadata.
---

# Reading and Writing the Accounting State File

## Location

The state file lives in Google Drive at:
```
DRIVE_ROOT_FOLDER_ID/YYYY-MM/.nilsark/state.md
```

## Download-Modify-Upload Cycle

Every command that reads or writes state follows this pattern:

1. **Resolve the `.nilsark` subfolder** within the month folder (find or create it). Assign the result to `NILSARK_FOLDER_ID`:
   ```bash
   NILSARK_LIST=$(gws drive files list --params '{"q": "name='\''.nilsark'\'' and '\''<month_folder_id>'\'' in parents and mimeType='\''application/vnd.google-apps.folder'\'' and trashed=false"}' --format json)
   # If the command failed (non-zero exit or non-JSON output), stop — do not create a folder on a transient error.
   NILSARK_FOLDER_ID=$(echo "$NILSARK_LIST" | jq -r '.files[0].id // empty')
   # Only create if list succeeded AND NILSARK_FOLDER_ID is still empty:
   if [ -z "$NILSARK_FOLDER_ID" ]; then
     NILSARK_FOLDER_ID=$(gws drive files create --json '{"name": ".nilsark", "mimeType": "application/vnd.google-apps.folder", "parents": ["<month_folder_id>"]}' --format json | jq -r '.id')
   fi
   ```

2. **Download** state.md from the `.nilsark` folder to local temp (`$STAGING_DIR/.state/YYYY-MM-state.md`). Capture the file ID — you will need it for the upload step:
   ```bash
   STATE_LIST=$(gws drive files list --params '{"q": "name='\''state.md'\'' and '\'''"$NILSARK_FOLDER_ID"'\'' in parents and trashed=false"}' --format json)
   # If the command failed (non-zero exit or non-JSON output), stop — do not create from template on a transient error.
   STATE_FILE_ID=$(echo "$STATE_LIST" | jq -r '.files[0].id // empty')
   # Only download if STATE_FILE_ID is non-empty (empty = genuine first run → create from template):
   [ -n "$STATE_FILE_ID" ] && cd "$STAGING_DIR/.state" && gws drive files get --params '{"fileId": "'$STATE_FILE_ID'", "alt": "media"}' -o YYYY-MM-state.md
   ```

3. **Modify** in memory (parse → update → write to temp file)

4. **Upload** back to Drive — update in-place if the file already exists, otherwise create:
   - If `$STATE_FILE_ID` is set (normal case):
     ```bash
     gws drive files update --params '{"fileId": "'$STATE_FILE_ID'"}' \
       --upload $STAGING_DIR/.state/YYYY-MM-state.md --upload-content-type text/markdown
     ```
   - If `$STATE_FILE_ID` is empty (first run — no state.md in Drive yet):
     ```bash
     cd "$STAGING_DIR/.state" && gws drive +upload YYYY-MM-state.md --parent <nilsark_folder_id> --name state.md
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

Then find or create the `.nilsark` subfolder as shown above.

## Parsing Tables

State.md uses markdown tables. Parse each row by:
1. Splitting on `|`
2. Trimming whitespace from each cell
3. Skipping the header row and the separator row (`|---|---|...`)
4. Treating blank cells as empty string / null

## Deduplication Check

Before downloading a Gmail attachment, check the Processed Gmail Messages table:
```
If message_id exists in the table AND ALL rows for that message_id have status = 'classified'
  OR status = 'skipped — covered by companion receipt' → skip this message (fully processed)
If any row has status 'downloaded' or 'error' → re-process (classification was never completed)
```

## Appending Rows

To add a new row to a table, append it after the last data row (before the next `##` section or end of file). Maintain column alignment for readability.

Example — appending to Documents table:
```markdown
| faktura-telia-2026-03.pdf | leverantörsfaktura | Telia Sverige AB | 1250.00 | SEK | 2026-04-15 | 1234567890 | BG 123456-7 | 250.00 | 2026-03/Leverantörsfakturor/faktura-telia-2026-03.pdf | 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74 | unpaid | no |
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

Create a blank state.md from the template (see docs/state-schema.md) and upload it to the `.nilsark` subfolder of the Drive month folder before proceeding.
