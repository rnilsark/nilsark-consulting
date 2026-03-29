# NILSARK Finance Config — Template

Copy this file to `~/.nilsark-config.md` and fill in your values.
This file lives in your home directory, NOT in the repo — it is machine-specific.

---

## Local Paths

# Absolute path to your local staging folder (temporary PDFs/CSVs land here).
# Use the WSL2/Git Bash form of the path even on Windows — Claude Desktop's Bash
# tool runs through WSL2 or Git Bash, not cmd.exe.
#
# Windows: /mnt/c/Users/YourName/Desktop/nilsark-staging
#           (this is C:\Users\YourName\Desktop\nilsark-staging in Explorer)
# Mac:     /Users/YourName/Desktop/nilsark-staging
STAGING_DIR=/mnt/c/Users/YourName/Desktop/nilsark-staging

---

## Google Drive

# The Google Drive folder ID for your root accounting folder.
# Open the folder in drive.google.com — the ID is the last segment of the URL:
#   https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ
#                                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
DRIVE_ROOT_FOLDER_ID=your-drive-folder-id-here

---

## Fortnox Email Routing

# Each Drive subfolder maps 1:1 to a Fortnox routing email.
# Leave a value empty to skip that folder during month-close.

# Verifikationer/ — receipts and auto-charged subscriptions
FORTNOX_EMAIL_VERIFIKATION=your-fortnox-verifikation-email@fortnox.se

# Leverantörsfakturor/ — supplier invoices
FORTNOX_EMAIL_LEVERANTORSFAKTURA=your-fortnox-leverantorsfaktura-email@fortnox.se

# Skattekonto/ — Skatteverket tax account documents
FORTNOX_EMAIL_SKATTEKONTO=

# Kundfakturor/ — your outgoing invoices to clients
FORTNOX_EMAIL_KUNDFAKTURA=your-fortnox-kundfaktura-email@fortnox.se

---

## Your Email

# Your own email address (used as BCC on Fortnox routing for audit trail)
MY_EMAIL=you@example.com
