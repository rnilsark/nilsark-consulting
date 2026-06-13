---
name: month-close
description: Prepare the bookkeeping handoff for a month as Gmail DRAFTS — one draft per document type with that type's PDFs attached and a filename-list body. Never sends. Self-contained leaf skill; invokes no other skill. Follows the State contract in the agent context and the draftTestMode recipient gate.
---

# Month-close (drafts only)

The agent invokes you only when the close is due (within the last 5 days of `MONTH` or `MONTH` past,
`state.json` `export_status = reconciled`, state.md `Month-close sent: no`). You create one Gmail
**draft** per document type that still has `fortnox_sent = no` rows. **You never send.** Follow the
*State contract* in your agent context for state.md; invoke no other skill.

Context you have: `MONTH`, `DRIVE_ROOT`, `STAGING_DIR`, `MY_EMAIL`, `fortnoxEmail.*`, `draftTestMode`.

## Per type

| Type | Documents rows | Subject type-label |
|---|---|---|
| Verifikationer | `type = kvitto` | `kvitton` |
| Leverantörsfakturor | `type = leverantörsfaktura` | `leverantörsfakturor` |
| Skattekonto | `type = skattekonto` | `skattekonto` |
| Kundfakturor | `type = kundfaktura` | `kundfakturor` |

For each type with `fortnox_sent = no` rows:

1. **Download its PDFs** from Drive into `$STAGING_DIR/$MONTH/`: use each row's `drive_file_id`; if
   blank or `upload-failed`, fall back to a name lookup in the type's subfolder. If a file is in
   neither, skip it and log "File not in Drive — manual upload required" (leave its `fortnox_sent = no`).
2. **Create ONE draft** with all that type's files attached. Body = a plain filename list only
   (`Bifogade filer: a.pdf, b.pdf`) — no accounts, sums, or VAT; the bookkeeper books from the
   attachments. `cd` into the staging month dir and pass relative filenames:
   ```bash
   cd "$STAGING_DIR/$MONTH"
   gws gmail +send --draft --to <recipient> --subject "<subject>" --body "Bifogade filer: a.pdf, b.pdf" -a "a.pdf" -a "b.pdf"
   ```
   Capture the draft id from stdout (`.id`); pipe stdout only (`2>/dev/null`) — `gws` prints a keyring
   banner to stderr that corrupts JSON. Treat a **non-zero exit** as failure (a masked success re-run
   creates duplicate drafts). On success mark those rows `fortnox_sent = yes`; on failure mark none
   for that type and report it.

## Recipient routing — `draftTestMode` (the safety gate)

- `draftTestMode == true` (default): address **every** draft to `MY_EMAIL`, prefix the subject with
  `[TEST]` — e.g. `[TEST] Nilsark Consulting AB — leverantörsfakturor — $MONTH`. Never a Fortnox address.
- `draftTestMode == false`: use the per-type `fortnoxEmail.*` address. Skip a type whose address is
  empty (log `skipped — not configured`).

Subject (non-test): `Nilsark Consulting AB — <type-label> — $MONTH`.

## Finish

After all non-skipped types succeed, set state.md `Month-close sent: yes` and `Month-close date:
TODAY`, and upload state.md. If any type failed, leave `Month-close sent: no` (already-drafted rows are
`fortnox_sent = yes`, so a retry skips them). Report per-type results to the agent. **Never send.**
