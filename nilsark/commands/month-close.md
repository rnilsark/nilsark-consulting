---
description: "Close the accounting month — route all documents to Fortnox via email and mark state.md as closed. Use --dry-run to preview without sending. Usage: /month-close [YYYY-MM] [--dry-run]"
argument-hint: YYYY-MM [--dry-run]
allowed-tools: ["Read", "Bash"]
---

# Month Close — Route Documents to Fortnox

You are closing the accounting month for NILSARK CONSULTING AB by routing all documents to Fortnox.

**Always run with `--dry-run` first to review what will be sent.**

## Step 1 — Read Config

```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
DRIVE_ROOT_FOLDER_ID=$(grep '^DRIVE_ROOT_FOLDER_ID=' ~/.nilsark-config.md | cut -d= -f2-)
FORTNOX_LEVERANTORSFAKTURA=$(grep '^FORTNOX_EMAIL_LEVERANTORSFAKTURA=' ~/.nilsark-config.md | cut -d= -f2-)
FORTNOX_KVITTO=$(grep '^FORTNOX_EMAIL_KVITTO=' ~/.nilsark-config.md | cut -d= -f2-)
FORTNOX_BANK_INVOICE=$(grep '^FORTNOX_EMAIL_BANK_INVOICE=' ~/.nilsark-config.md | cut -d= -f2-)
MY_EMAIL=$(grep '^MY_EMAIL=' ~/.nilsark-config.md | cut -d= -f2-)
DRY_RUN=false
```

Check if `--dry-run` is in `$ARGUMENTS` and set `DRY_RUN=true` if so.

## Step 2 — Determine Month

Use argument if provided (ignoring `--dry-run`), otherwise `date +%Y-%m`.

## Step 3 — Download state.md

> **Auth guard:** If any `gws` command in this step exits with a non-zero code and its output contains "auth", "token", "unauthenticated", "unauthorized", or "login", stop immediately and run `/nilsark:gws-auth`. After the user completes auth, retry from this step.

Download state.md from Drive.

## Step 4 — Guard: Already Closed?

Check if `Month-close sent: yes` in the Month Summary section.

If yes and NOT in dry-run mode: stop and tell the user:
> Month $MONTH has already been closed. Run with `--dry-run` to review what was sent, or manually edit state.md in Drive to re-open.

## Step 5 — Build Routing Plan

Collect documents to route from the Documents table:

**Leverantörsfakturor** (fortnox_sent = no, type = leverantorsfaktura):
- Route to: `$FORTNOX_LEVERANTORSFAKTURA`
- Method: forward original Gmail message if `message_id` is available in state.md
- Fallback (no message_id — locally scanned): send new email with Drive link

**Kvitton** (fortnox_sent = no, type = kvitto):
- Route to: `$FORTNOX_KVITTO`
- Method: forward original Gmail message if available
- Fallback: send new email with Drive link

**Bank statement** (`Kontohändelser.pdf` in `$STAGING_DIR/$MONTH/` or Drive root of month):
- Route to: `$FORTNOX_BANK_INVOICE`
- Method: send new email with the PDF as a forward or Drive link

**Outgoing invoice** (your invoice to your client — files matching `invoice*` in Drive month root):
- Route to: `$FORTNOX_BANK_INVOICE`
- Method: forward original Gmail message if available, otherwise Drive link

## Step 6 — Dry Run Output

If `DRY_RUN=true`, print the full routing plan and stop:

```
DRY RUN — Month Close 2026-03
No emails will be sent.

Would send:
  → FORTNOX_LEVERANTORSFAKTURA
    [forward] Telia Sverige AB — faktura-telia-2026-03.pdf (msg_id: 18f1a2b3c4d)
    [forward] AWS EMEA SARL — invoice-aws-2026-03.pdf (msg_id: 18e2b3c4d5e)
    [drive-link] Lokal skanning — kvitto-scanned.pdf (no Gmail msg_id — will send Drive link)

  → FORTNOX_KVITTO
    [forward] ICA Kvitto 2026-03-15 (msg_id: 18d3c4d5e6f)

  → FORTNOX_BANK_INVOICE
    [upload] Kontohändelser.pdf
    [forward] Invoice 2026-03 to Client AB (msg_id: 18c4d5e6f70)

Nothing will be sent. Re-run without --dry-run to execute.
```

## Step 7 — Execute (non-dry-run only)

For each document in the routing plan:

**Forward method** (original Gmail message available):
```bash
gws gmail +forward --message-id <message_id> --to <fortnox_email>
```

**Drive link fallback** (no Gmail message_id):
Find the file in Drive and get its shareable link, then:
```bash
gws gmail +send \
  --to <fortnox_email> \
  --subject "<Type>: <supplier> <amount> SEK — <date>" \
  --body "Se bifogad fil i Google Drive: https://drive.google.com/file/d/<file_id>/view\n\nFil: <filename>\nLeverantör: <supplier>\nBelopp: <amount> SEK"
```

After each successful send:
- Update `fortnox_sent = yes` for that document in the Documents table
- Add it to the send log

If a send fails: log the failure, continue with the next document. Do not mark as sent.

## Step 8 — Update Month Summary

If all sends succeeded (or at least all were attempted):
```
Month-close sent: yes
Month-close date: YYYY-MM-DD
```

## Step 9 — Upload state.md

Upload the final state.md back to Drive.

## Step 10 — Print Final Report

```
Month Close Complete — 2026-03

Sent to Fortnox:
  ✓ Leverantörsfakturor: 2 documents
  ✓ Kvitton: 1 document
  ✓ Bank statement + outgoing invoice

Fallback (Drive link, no attachment):
  ! kvitto-scanned.pdf — sent as Drive link to FORTNOX_KVITTO

Failures:
  None

state.md updated. Month 2026-03 is closed.
```

If there were any failures, list them explicitly and remind the user to retry manually.
