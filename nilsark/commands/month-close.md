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

Check if `--dry-run` is in `$ARGUMENTS` and set `DRY_RUN=true` if so.

## Step 2 — Determine Month

Use argument if provided (ignoring `--dry-run`), otherwise `date +%Y-%m`.

## Step 3 — Download state.md

> **Auth guard:** If any `gws` command in this step exits with a non-zero code and its output contains "auth", "token", "unauthenticated", "unauthorized", or "login", stop immediately and run `/nilsark:gws-auth`. After the user completes auth, retry from this step.

Download state.md from Drive (see `nilsark:accounting-state` skill for the download pattern).

## Step 4 — Guard: Already Closed?

Check if `Month-close sent: yes` in the Month Summary section.

If yes and NOT in dry-run mode: stop and tell the user:
> Month $MONTH has already been closed. Run with `--dry-run` to review what was sent, or manually edit state.md in Drive to re-open.

## Step 5 — Build Routing Plan

Process each Drive subfolder in order. For each folder, if the corresponding config email is empty → skip it entirely and log `skipped — FORTNOX_EMAIL_X not configured`.

**Verifikationer/** → `$FORTNOX_VERIFIKATION`
- From state.md: all rows where `type = kvitto` and `fortnox_sent = no`
- Method: forward original Gmail message if `message_id` is available; else download from Drive and send as attachment

**Leverantörsfakturor/** → `$FORTNOX_LEVERANTORSFAKTURA`
- From state.md: all rows where `type = leverantörsfaktura` and `fortnox_sent = no`
- Method: forward original Gmail message if `message_id` is available; else download from Drive and send as attachment

**Skattekonto/** → `$FORTNOX_SKATTEKONTO`
- From state.md: all rows where `type = skattekonto` and `fortnox_sent = no`
- Method: download file from Drive and send as attachment

**Kundfakturor/** → `$FORTNOX_KUNDFAKTURA`
- List all files in `YYYY-MM/Kundfakturor/` in Drive directly (not tracked in state.md)
- Method: download each file from Drive and send as attachment

## Step 6 — Dry Run Output

If `DRY_RUN=true`, print the full routing plan and stop:

```
DRY RUN — Month Close 2026-03
No drafts will be created.

Would send:
  → FORTNOX_VERIFIKATION
    [forward] Supplier A — receipt-a.pdf (msg_id: abc123)
    [forward] Supplier B — receipt-b.pdf (msg_id: def456)

  → FORTNOX_LEVERANTORSFAKTURA
    [forward] Supplier C — invoice-c.pdf (msg_id: ghi789)
    [attachment] Supplier D — invoice-d.pdf (no Gmail msg_id — downloaded from Drive)

  → FORTNOX_SKATTEKONTO  skipped — FORTNOX_EMAIL_SKATTEKONTO not configured

  → FORTNOX_KUNDFAKTURA
    [attachment] client-invoice-2026-03.pdf (downloaded from Drive)

No drafts will be created. Re-run without --dry-run to create them.
```

## Step 7 — Execute (non-dry-run only)

For each document in the routing plan:

**Forward method** (original Gmail message_id available):

Create a draft that forwards the original message:
```bash
gws gmail +draft-forward --message-id <message_id> --to <fortnox_email>
```

**Attachment method** (no Gmail message_id — Skattekonto, Kundfakturor, or locally scanned docs):

Download the file from Drive to local staging first:
```bash
gws drive files get --params '{"fileId": "<file_id>", "alt": "media"}' -o "$STAGING_DIR/$MONTH/<filename>"
```

Then create a draft with the file attached:
```bash
gws gmail +draft \
  --to <fortnox_email> \
  --subject "<type>: <supplier> <amount> <currency> — <YYYY-MM>" \
  --body "Bifogad fil: <filename>" \
  --attachment "$STAGING_DIR/$MONTH/<filename>"
```

After each draft is successfully created:
- Update `fortnox_sent = yes` for that document in the Documents table
- Add it to the draft log

If a draft creation fails: log the failure, continue with the next document. Do not mark as sent.

## Step 8 — Update Month Summary

If all drafts were created (or at least all were attempted):
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
  ✓ Verifikationer: 2 drafts  → FORTNOX_VERIFIKATION
  ✓ Leverantörsfakturor: 2 drafts  → FORTNOX_LEVERANTORSFAKTURA
  - Skattekonto: skipped — FORTNOX_EMAIL_SKATTEKONTO not configured
  ✓ Kundfakturor: 1 draft  → FORTNOX_KUNDFAKTURA

Failures:
  None

Drafts are ready in Gmail — review and send manually.
state.md updated. Month 2026-03 is closed.
```

If there were any failures, list them explicitly and remind the user to retry manually.
