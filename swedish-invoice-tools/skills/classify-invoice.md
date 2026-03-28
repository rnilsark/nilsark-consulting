---
description: Classify a Swedish PDF document as a leverantörsfaktura (supplier invoice) or kvitto (receipt). Use this skill when reading any Swedish accounting document that needs to be categorized.
---

# Classifying Swedish Accounting Documents

When asked to classify a Swedish PDF or image document, apply these rules:

## Document Types

### Leverantörsfaktura (Supplier Invoice)
A leverantörsfaktura is a bill that must be paid at a future date. Indicators:
- Has a **Förfallodatum** (due date) — the most reliable indicator
- Has an **OCR-nummer** (payment reference number)
- Has payment instructions: **Bankgiro** (BG XXXXXX-X) or **Plusgiro** (PG XXXXX-X)
- Billed TO a Swedish company (look for org.nr, momsreg.nr of the recipient)
- Typically from a recurring supplier: telecom, SaaS, utilities, professional services
- May show **Fakturanummer** (invoice number) and **Fakturadatum** (invoice date)

### Kvitto (Receipt)
A kvitto documents a purchase that has already been paid. Indicators:
- No Förfallodatum
- Shows a payment method: card, Swish, cash
- Often from retail, restaurants, transport, or online stores
- May show "Betalt" (paid), "Kvittens", or a card terminal printout
- Usually has a smaller, simpler format than a faktura

## Classification Decision

**If the document has Förfallodatum → leverantörsfaktura**
**If the document has no Förfallodatum and shows completed payment → kvitto**
**If neither rule gives high confidence → unknown** (flag for manual review)

Mark as `unknown` if:
- The document is in a foreign language and the classification is uncertain
- The document is damaged, low-resolution, or partially unreadable
- It is genuinely ambiguous (e.g., a receipt that also has a future payment)

## Output Format

Return the classification as one of: `leverantorsfaktura`, `kvitto`, `unknown`

Always explain briefly which indicator led to the classification (e.g., "Förfallodatum found: 2026-04-15 → leverantörsfaktura").
