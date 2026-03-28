# Fortnox Document Routing

The `/month-close` command routes accounting documents to Fortnox via email. This document describes the routing rules, email addresses, and known limitations.

---

## Routing Rules

| Document Type | Destination | Method |
|--------------|-------------|--------|
| Leverantörsfakturor | `FORTNOX_EMAIL_LEVERANTORSFAKTURA` | Forward original Gmail message |
| Kvitton | `FORTNOX_EMAIL_KVITTO` | Forward original Gmail message |
| Bank statement (Kontohändelser.pdf) | `FORTNOX_EMAIL_BANK_INVOICE` | New email with Drive link |
| Outgoing invoice (my invoice to client) | `FORTNOX_EMAIL_BANK_INVOICE` | Forward original Gmail message (or Drive link) |

All three email addresses are configured in `~/.nilsark-config.md`.

---

## How Forwarding Works

For documents that arrived via Gmail, the command uses:

```bash
gws gmail +forward --message-id <original_gmail_message_id> --to <fortnox_email>
```

This forwards the original email with the original attachment intact. The `message_id` is stored in `state.md` under Processed Gmail Messages.

---

## Known Limitation: Locally Scanned Documents

If a kvitto or leverantörsfaktura was **not received via Gmail** (e.g., a physical receipt you scanned and added manually to the staging folder), there is no `message_id` to forward.

**Fallback for these documents:**

The month-close command sends a new email with a Google Drive link to the file:

```
Subject: Kvitto: <supplier> <amount> SEK — <date>
Body: Se bifogad fil i Google Drive: https://drive.google.com/file/d/<file_id>/view
```

This means Fortnox receives a link rather than an attached PDF. If your Fortnox setup requires actual attachments, you must manually forward these documents after running `/month-close`.

The command will clearly list which documents used the fallback method so you know what needs manual follow-up.

---

## Configuring Fortnox Email Addresses

Fortnox provides unique email addresses for document import under **Inställningar → Integrationer → E-postimport**.

Typical format: `{company-id}+{type}@import.fortnox.se`

Contact Fortnox support or check your Fortnox account settings to find your specific addresses.

---

## Dry Run

Always preview before executing:

```
/month-close 2026-03 --dry-run
```

In dry-run mode, the command prints a complete list of what would be sent (recipient, subject, document, method) without actually sending anything or modifying `state.md`.
