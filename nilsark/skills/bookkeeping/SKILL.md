---
name: bookkeeping
description: NILSARK's bookkeeping handoff — how verifications are forwarded to the bookkeeper. One email per document type, the type's PDFs attached, body is a short list of the attached filenames. Used by /month-close.
---

# Bookkeeping

The company forwards verifications to a bookkeeper. This skill defines how that handoff is
produced. It is intentionally minimal: the bookkeeper (and Fortnox e-post import) books from
the **attachments** — the email body is not parsed. So keep the body to a plain filename list.

**Do not** put account suggestions, sums, or VAT in the email. The account structure is not
ours to assume, and a wrong suggestion only creates work to correct. The bookkeeper books from
the attachments.

## Handoff format

Produced by `/month-close`, one email **per document type** that has documents with
`fortnox_sent = no`:

- **To:** the type's Fortnox address (`FORTNOX_EMAIL_*`).
- **Subject:** `Nilsark Consulting AB — <type-label> — <YYYY-MM>`
  (type-labels: `kvitton`, `leverantörsfakturor`, `skattekonto`, `kundfakturor`).
- **Attachments:** that type's PDFs (downloaded from Drive).
- **Body:** a short list of the attached filenames, nothing else, e.g.
  `Bifogade filer: a.pdf, b.pdf, c.pdf`

That is the whole format.
