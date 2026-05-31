---
description: "Close the accounting month — create Gmail drafts for all Fortnox routing emails and mark state.md as closed. Use --dry-run to preview without creating drafts. Usage: /month-close [YYYY-MM] [--dry-run]"
argument-hint: YYYY-MM [--dry-run]
allowed-tools: ["Read", "Bash"]
---

# Month Close — Route Documents to Fortnox

You are closing the accounting month for NILSARK CONSULTING AB by creating Gmail drafts for all Fortnox routing emails. The user reviews and sends the drafts manually.

**Always run with `--dry-run` first to review what drafts will be created.**

## Step 1 — Read Config

```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
DRIVE_ROOT_FOLDER_ID=$(grep '^DRIVE_ROOT_FOLDER_ID=' ~/.nilsark-config.md | cut -d= -f2-)
FORTNOX_VERIFIKATION=$(grep '^FORTNOX_EMAIL_VERIFIKATION=' ~/.nilsark-config.md | cut -d= -f2-)
FORTNOX_LEVERANTORSFAKTURA=$(grep '^FORTNOX_EMAIL_LEVERANTORSFAKTURA=' ~/.nilsark-config.md | cut -d= -f2-)
FORTNOX_SKATTEKONTO=$(grep '^FORTNOX_EMAIL_SKATTEKONTO=' ~/.nilsark-config.md | cut -d= -f2-)
FORTNOX_KUNDFAKTURA=$(grep '^FORTNOX_EMAIL_KUNDFAKTURA=' ~/.nilsark-config.md | cut -d= -f2-)
MY_EMAIL=$(grep '^MY_EMAIL=' ~/.nilsark-config.md | cut -d= -f2-)
DRY_RUN=false
```

> **Send rule (strict):** Everything this command produces for Fortnox is a **draft** —
> always pass `--draft` to `gws gmail +send`. **Never** send a Fortnox email. The user
> spot-checks the drafts and sends them. This command sends nothing.

Check if `--dry-run` is in `$ARGUMENTS` and set `DRY_RUN=true` if so.

## Step 2 — Determine Month

Use argument if provided (ignoring `--dry-run`), otherwise `date +%Y-%m`.

## Step 3 — Download state.md

> **Auth guard:** If any `gws` command in this command exits with a non-zero code and its output contains "auth", "token", "unauthenticated", "unauthorized", or "login", stop immediately and run `/nilsark:gws-auth`. After the user completes auth, retry from this step. This guard applies to all gws calls in all subsequent steps, not just Step 3.

Download state.md from Drive (see `nilsark:accounting-state` skill for the download pattern).

## Step 4 — Guard: Already Closed?

Check if `Month-close sent: yes` in the Month Summary section.

If yes and NOT in dry-run mode: stop and tell the user:
> Month $MONTH has already been closed. Run with `--dry-run` to review what was sent, or manually edit state.md in Drive to re-open.

## Step 5 — Build Routing Plan

Process each document type in order. For each type, if the corresponding config email is empty → skip it entirely and log `skipped — FORTNOX_EMAIL_X not configured`.

**Verifikationer** → `$FORTNOX_VERIFIKATION`
- From state.md: all rows where `type = kvitto` and `fortnox_sent = no`
- Method: download all PDFs from Drive, send as ONE email with all attached

**Leverantörsfakturor** → `$FORTNOX_LEVERANTORSFAKTURA`
- From state.md: all rows where `type = leverantörsfaktura` and `fortnox_sent = no`
- Method: download all PDFs from Drive, send as ONE email with all attached

**Skattekonto** → `$FORTNOX_SKATTEKONTO`
- From state.md: all rows where `type = skattekonto` and `fortnox_sent = no`
- Method: download all PDFs from Drive, send as ONE email with all attached

**Kundfakturor** → `$FORTNOX_KUNDFAKTURA`
- Find the `Kundfakturor/` folder in Drive under the month folder and assign its ID to `KUNDFAKTURA_FOLDER_ID`. If the folder does not exist, treat this type as "no documents this month" and skip it (do not error).
- List all files in the folder. If the folder is empty, skip this type.
- Method: download all PDFs from Drive, send as ONE email with all attached

## Step 6 — Dry Run Output

If `DRY_RUN=true`, print the routing plan (recipient, subject, and the attached filenames per
type), then stop:

```
DRY RUN — Month Close 2026-03
No drafts will be created.

Would send (1 email per type):
  → FORTNOX_VERIFIKATION  (1 email, 2 attachments)
    Subject: Nilsark Consulting AB — kvitton — 2026-03
    Bifogade filer: receipt-a.pdf, receipt-b.pdf

  → FORTNOX_LEVERANTORSFAKTURA  (1 email, 2 attachments)
    Subject: Nilsark Consulting AB — leverantörsfakturor — 2026-03
    Bifogade filer: invoice-c.pdf, invoice-d.pdf

  → FORTNOX_SKATTEKONTO  skipped — FORTNOX_EMAIL_SKATTEKONTO not configured
  → FORTNOX_KUNDFAKTURA  (1 email, 1 attachment)
    Subject: Nilsark Consulting AB — kundfakturor — 2026-03
    Bifogade filer: client-invoice-2026-03.pdf

No drafts will be created. Re-run without --dry-run to create them.
```

## Step 7 — Execute (non-dry-run only)

For each document type in the routing plan, create ONE email with all documents of that type as attachments.

**Resolve the type folder ID** before downloading. Use a Drive files list query to find the subfolder by name under the month folder (e.g. `Verifikationer`, `Leverantörsfakturor`, `Skattekonto`). Assign the result to `TYPE_FOLDER_ID`. For Kundfakturor, use `$KUNDFAKTURA_FOLDER_ID` resolved in Step 5 — do not re-query.

**For each document in the type group — download from Drive:**

Use `drive_file_id` from the Documents table if the value is non-empty and not equal to `upload-failed`. If it is blank or `upload-failed`, fall back to a name lookup using `TYPE_FOLDER_ID`:
```bash
gws drive files list --params '{"q": "name='\''<filename>'\'' and '\''<TYPE_FOLDER_ID>'\'' in parents and trashed=false"}' --format json | jq -r '.files[0].id'
```

If the name lookup also returns no results (the file was never uploaded), skip this document, log it as a failure with the message "File not in Drive — manual upload required", and continue with the next document.

Download to local staging:
```bash
gws drive files get --params '{"fileId": "<file_id>", "alt": "media"}' -o "$STAGING_DIR/$MONTH/<filename>"
```

**Create ONE draft per type with all files attached:**

Follow the `bookkeeping` skill: the body is just a short list of the attached filenames — no
summaries, accounts, or sums. Use `gws gmail +send --draft` with `-a/--attach` (one per file)
— **always `--draft`**, this is a Fortnox email so it must never be sent. `cd` into the month
staging directory first and pass relative filenames — do not pass absolute paths in `-a`.

```bash
cd "$STAGING_DIR/$MONTH"
gws gmail +send --draft \
  --to <fortnox_email> \
  --subject "Nilsark Consulting AB — <type-label> — $MONTH" \
  --body "Bifogade filer: file1.pdf, file2.pdf" \
  -a "file1.pdf" \
  -a "file2.pdf" \
  ...
```

Capture the draft id from the JSON response (`.id`). **Do not pipe `gws` through
`jq` with `2>&1`** — `gws` prints a `Using keyring backend` banner to stderr that
corrupts the JSON stream and makes a successful create look like a failure. Pipe
stdout only (`2>/dev/null | jq ...`) or read the raw output. Treat a non-zero
**exit code** as the failure signal, not a `jq` parse error — re-running after a
masked success creates duplicate drafts.

Subject type-labels:
- Verifikationer: `kvitton`
- Leverantörsfakturor: `leverantörsfakturor`
- Skattekonto: `skattekonto`
- Kundfakturor: `kundfakturor`

On success: update `fortnox_sent = yes` only for the documents that were successfully downloaded and included in the draft (i.e. not skipped due to missing Drive file). Documents that were skipped with "File not in Drive" retain `fortnox_sent = no` so they appear in future re-runs after manual upload.

On failure: log the failure, mark none as sent for this type. Do not attempt partial sends.

## Step 8 — Update Month Summary

Only update the month summary if **all** draft creations succeeded (no failures logged). Skipped types (empty folder, unconfigured email, or no `fortnox_sent = no` documents remaining) do not count as failures. If any type failed, leave `Month-close sent: no` so the command can be retried — documents already marked `fortnox_sent = yes` will be skipped on re-run (the routing plan in Step 5 filters them out).

If all non-skipped types succeeded:
```
Month-close sent: yes
Month-close date: YYYY-MM-DD
```

## Step 9 — Upload state.md

Upload the final state.md back to Drive (see `nilsark:accounting-state` skill for the upload pattern).

## Step 10 — Print Final Report

```
Month Close Complete — 2026-03

Drafts created:
  ✓ Verifikationer: 1 draft (2 attachments)  → FORTNOX_VERIFIKATION
  ✓ Leverantörsfakturor: 1 draft (2 attachments)  → FORTNOX_LEVERANTORSFAKTURA
  - Skattekonto: skipped — FORTNOX_EMAIL_SKATTEKONTO not configured
  ✓ Kundfakturor: 1 draft (1 attachment)  → FORTNOX_KUNDFAKTURA

Failures:
  None

Missing files (manual upload required):
  None

Drafts are ready in Gmail — review and send manually.
state.md updated. Month 2026-03 is closed.
```

If there were any failures, list them explicitly and remind the user to retry manually.

If any documents were skipped due to missing Drive file, list them under "Missing files (manual upload required)" and instruct the user to upload the file to the correct Drive subfolder and re-run `/month-close`.
