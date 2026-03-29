---
description: Classify a Swedish PDF document as a leverantörsfaktura (supplier invoice), kvitto (receipt), skattekonto (tax payment), or unknown. Use this skill when reading any Swedish accounting document that needs to be categorized.
---

# Classifying Swedish Accounting Documents

When asked to classify a Swedish PDF or image document, apply these rules **in order** — the first matching rule wins.

## Document Types

### Skattekonto (Tax Authority Payment)
A tax payment instruction from Skatteverket for the company's tax obligations. Indicators:
- Sender is **Skatteverket**
- Header contains **"Skattekonto"**
- Lists tax line items: **arbetsgivaravgift**, **preliminärskatt** (F-skatt or avdragen skatt)
- Has OCR to Skatteverkets bankgiro **5050-1055**
- Shows a calculated "Belopp att betala" based on upcoming tax transactions

This is NOT a supplier invoice. Classify as `skattekonto`.

### Kvitto (Receipt)
A kvitto documents a purchase that is already paid or will be charged automatically — no separate payment action is needed. Indicators:
- No Förfallodatum, OR
- **Auto-charged to card:** document states "Beloppet dras från ditt registrerade kort", "Debiteras automatiskt", "Du debiteras automatiskt", or similar — classify as `kvitto` even if a Fakturanummer is present, because the charge happens automatically with no manual payment step
- Shows a payment method: card number, Swish, cash, or "Betalt"
- Often from retail, restaurants, transport, SaaS subscriptions billed to card
- May show "Kvittens" or a card terminal printout
- If the document is explicitly labeled "Receipt" and shows "Amount paid" → kvitto

### Leverantörsfaktura (Supplier Invoice)
A bill that requires a manual payment at a future date. Indicators:
- Has a **Förfallodatum** (due date) — the most reliable indicator
- Has an **OCR-nummer** for bank payment
- Has payment instructions: **Bankgiro** (BG XXXXXX-X) or **Plusgiro** (PG XXXXX-X)
- No auto-charge language
- Billed TO a Swedish company (org.nr, momsreg.nr of recipient)

## Classification Decision

**Check in this order:**
1. From Skatteverket + skattekonto content → `skattekonto`
2. Auto-charge language present → `kvitto`
3. Explicitly labeled "Receipt" / "Amount paid" → `kvitto`
4. Has Förfallodatum + manual payment details → `leverantorsfaktura`
5. No Förfallodatum, shows completed payment → `kvitto`
6. None of the above with high confidence → `unknown`

Mark as `unknown` if:
- The document is in a foreign language and the classification is uncertain
- The document is damaged, low-resolution, or partially unreadable
- It is genuinely ambiguous

## Output Format

Return the classification as one of: `leverantorsfaktura`, `kvitto`, `skattekonto`, `unknown`

Always explain briefly which indicator led to the classification (e.g., "Auto-charge language found: 'Beloppet dras från ditt registrerade kort' → kvitto").
