---
description: "Remove classified documents from the local staging folder for a given month. Only deletes files confirmed uploaded to Drive (drive_path set in state.md). Usage: /cleanup-staging [YYYY-MM]"
argument-hint: YYYY-MM (defaults to current month)
allowed-tools: ["Read", "Bash"]
---

# Clean Up Staging Folder

You are cleaning up the local staging folder for NILSARK CONSULTING AB. Only files that have been classified and confirmed uploaded to Drive are deleted.

## Step 1 — Read Config

```bash
STAGING_DIR=$(grep '^STAGING_DIR=' ~/.nilsark-config.md | cut -d= -f2-)
```

## Step 2 — Determine Month

Use argument if provided, otherwise `date +%Y-%m`.

## Step 3 — Load state.md

Read the local state file at `$STAGING_DIR/.state/$MONTH-state.md`.

If it does not exist, stop:
> No local state found for $MONTH. Run /fetch-attachments first, or the staging folder may already be clean.

## Step 4 — Identify Files to Delete

From the Documents table in state.md, collect all rows where `drive_path` is non-empty. These files are confirmed uploaded to Drive and safe to delete locally.

From all other files in `$STAGING_DIR/$MONTH/`, identify what to keep:
- Files not yet in the Documents table (unclassified)
- Files with an empty `drive_path` (classification attempted but not uploaded)
- CSV files (bank statement exports — user-provided, not uploaded to Drive)

## Step 5 — Delete Classified Files

For each file identified in Step 4:
```bash
rm "$STAGING_DIR/$MONTH/<filename>"
```

Also remove the local state cache for this month:
```bash
rm "$STAGING_DIR/.state/$MONTH-state.md"
```

If the month directory is now empty, remove it:
```bash
rmdir "$STAGING_DIR/$MONTH" 2>/dev/null || true
```

## Step 6 — Print Report

```
Cleanup complete for YYYY-MM:
  Deleted: N files (confirmed in Drive)
  Kept: M files (not yet classified or uploaded)
    - <filename>: <reason>

Local state cache removed: $STAGING_DIR/.state/YYYY-MM-state.md
```

If nothing was deleted, say:
> Nothing to clean for $MONTH — no files with a confirmed Drive upload found.
