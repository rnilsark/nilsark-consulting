---
description: "Fetch Gmail attachments for the current (or specified) month and save them to the local staging folder. Skips already-processed messages. Safe to run multiple times. Usage: /fetch-attachments [YYYY-MM]"
argument-hint: YYYY-MM (defaults to current month)
allowed-tools: ["Bash"]
---

# Fetch Gmail Attachments

You are fetching email attachments for NILSARK CONSULTING AB's monthly accounting.

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

If the month folder exists, get its ID and download state.md:
```bash
gws drive files list --params '{"q": "name='\''state.md'\'' and '\''<MONTH_FOLDER_ID>'\'' in parents and trashed=false"}' --format json
cd "$STAGING_DIR/.state" && gws drive files get --params '{"fileId": "<STATE_FILE_ID>", "alt": "media"}' -o "$MONTH-state.md"
```

If the month folder does not exist yet, create it:
```bash
gws drive files create --json '{"name": "'"$MONTH"'", "mimeType": "application/vnd.google-apps.folder", "parents": ["'"$DRIVE_ROOT_FOLDER_ID"'"]}'
```

If state.md does not exist yet, create it from the template defined in the `accounting-state` skill (see First Run section).

## Step 5 — Parse Existing Message IDs

Read the local state.md and extract all `message_id` values from the Processed Gmail Messages table. These will be skipped.

## Step 6 — Search Gmail for Attachments

```bash
gws gmail users messages list --params '{"userId": "me", "q": "has:attachment in:inbox after:'"$FIRST_DAY"' before:'"$LAST_DAY"'", "maxResults": 100}' --format json
```

This returns a list of message IDs.

## Step 7 — Process Each Message

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

Use the original filename from the message. If two files have the same name, append the message_id as suffix.

**d) Update state.md:** Append a row to the Processed Gmail Messages table:
```
| <message_id> | <date> | <from> | <subject> | <filename> | downloaded |
```

If any step (b, c) fails, append the row with status `error` and continue to the next message. Do not abort.

## Step 8 — Upload Updated state.md

Upload the modified state.md back to Drive:
```bash
gws drive +upload "$STAGING_DIR/.state/$MONTH-state.md" --parent <MONTH_FOLDER_ID> --name state.md
```

If a state.md already exists in Drive, this overwrites it.

## Step 9 — Print Summary

```
Fetch complete for 2026-03:
  New messages processed: N
  Attachments downloaded: M
  Messages skipped (already processed): K
  Errors: E (check state.md for details)

Files saved to: $STAGING_DIR/2026-03/
```
