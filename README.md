# nilsark-consulting

Claude Code plugins for automating monthly accounting workflows for NILSARK CONSULTING AB (Swedish freelance AB).

## What This Does

Each month you receive invoices and receipts via Gmail. This system:

1. **Fetches** email attachments from Gmail to a local staging folder
2. **Classifies** each PDF as a leverantörsfaktura or kvitto, extracts accounting fields, and files it to the correct Google Drive subfolder
3. **Tracks** unpaid leverantörsfakturor and flags overdue items
4. **Matches** a bank statement (CSV or PDF) against invoices to update payment status — drop it in the staging `drop/` folder and `/fetch-classify` picks it up automatically
5. **Closes** the month by routing all documents to Fortnox via email

All state lives in Google Drive (`state.md` per month). Local staging is temporary only.

### AI CFO heartbeat

`/cfo-run` is the recurring orchestrator: it runs collection + classification + bank
matching, refreshes payment status, scans for anomalies, and emails you a **todo** of the
things only you can do — **PAY** (invoices, BankID), **EXPORT** (bank statement, BankID), and
**APPROVE** (spot-check and send the bookkeeper draft) — sorted by urgency. Email behavior
follows a strict rule (see
`cfo-policy`): **Fortnox/bookkeeper emails are always drafts (never sent)**, while
**self-notifications are sent only to your own address**. The agent never pays or does
BankID. You are the scheduler for now — run `/cfo-run` weekly/biweekly; `/month-close`
handles the monthly full close. See [docs/cfo-architecture.md](docs/cfo-architecture.md).

---

## Plugins

| Plugin | Type | Purpose |
|--------|------|---------|
| `swedish-invoice-tools` | General | Skills for classifying Swedish invoices, extracting fields, matching bank transactions |
| `nilsark` | Specific | Commands that orchestrate the full NILSARK workflow |

---

## Prerequisites

- **Claude Code CLI** (`claude`) — `npm install -g @anthropic-ai/claude-code`
- **gws CLI** — `npm install -g @googleworkspace/cli`
- **git**
- WSL2 (Windows) or macOS

---

## First-Time Setup

### 1. Clone this repo

```bash
git clone <repo-url> /mnt/c/dev/nilsark-consulting
# Mac:
git clone <repo-url> ~/dev/nilsark-consulting
```

### 2. Authenticate gws

```bash
gws auth login
```

This opens a browser for Google OAuth. Credentials are stored in `~/.gws/`. You must re-run this on each new machine.

### 3. Create your config file

```bash
cp /mnt/c/dev/nilsark-consulting/config.template.md ~/.nilsark-config.md
```

Edit `~/.nilsark-config.md` and fill in:
- `STAGING_DIR` — local path for temporary PDFs
- `DRIVE_ROOT_FOLDER_ID` — Google Drive folder ID (see instructions in the template)
- Fortnox email addresses
- Your email

### 4. Create your local staging folder

```bash
mkdir -p /mnt/c/Users/YourName/Desktop/nilsark-staging
```

### 5. Register plugins permanently

Add to `~/.claude/settings.json`:

```json
{
  "plugins": [
    "/mnt/c/dev/nilsark-consulting/swedish-invoice-tools",
    "/mnt/c/dev/nilsark-consulting/nilsark"
  ]
}
```

After this, just run `claude` — no flags needed. Type `/help` to confirm both plugins appear.

---

## Monthly Workflow

Run these commands in order. Steps 1–2 are idempotent — safe to run multiple times as new invoices arrive during the month.

### Step 1 — Fetch attachments

```
/fetch-attachments 2026-03
```

Downloads new Gmail attachments for the month to your staging folder. Skips already-processed messages.

### Step 2 — Classify documents

```
/classify 2026-03
```

Reads each PDF from staging, classifies it, extracts accounting fields, uploads to the correct Drive subfolder, and updates `state.md`.

Drive structure:
```
2026-03/
├── state.md
├── Kontohändelser.pdf
├── invoice - <number>
├── Verifikationer/
│   └── kvitto-xxx.pdf              ← kvitton + unknown here
├── Leverantörsfakturor/
│   └── faktura-xxx.pdf             ← leverantörsfakturor here
└── Skattekonto/
    └── skattekonto-xxx.pdf         ← skattekonto here
```

### Step 3 — Check payments (run anytime)

```
/payments-due 2026-03
```

Shows all unpaid leverantörsfakturor with due dates and amounts. Flags overdue items.

### Step 4 — Match bank statement

Bank matching is built into `/fetch-classify`. Export your Handelsbanken statement — as a **CSV** or a **PDF** — and drop it into the staging `drop/` folder:

```
$STAGING_DIR/drop/kontoutdrag-2026-03.pdf
```

Then run `/fetch-classify` as usual. It detects the statement, matches transactions against unpaid invoices, updates payment status in `state.md`, archives the statement to `2026-03/.nilsark/`, and prints a match report listing every transaction line.

### Step 5 — Close the month

Preview first:
```
/month-close 2026-03 --dry-run
```

Then execute:
```
/month-close 2026-03
```

Routes all documents to Fortnox via email and marks the month as closed.

---

## State File

Each month has a `state.md` in Google Drive that tracks every document and its status. See [docs/state-schema.md](docs/state-schema.md) for the full schema.

## Fortnox Routing

See [docs/fortnox-routing.md](docs/fortnox-routing.md) for routing rules and known limitations.

## New Machine Setup

See [docs/setup.md](docs/setup.md) for detailed per-OS setup instructions.
