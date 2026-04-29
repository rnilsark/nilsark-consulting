---
name: extract-invoice-fields
description: Extract structured accounting fields from a Swedish leverantörsfaktura or kvitto. Use this skill after classifying a document to get the data needed for bookkeeping.
---

# Extracting Accounting Fields from Swedish Documents

After classifying a document, extract the following fields. Not all fields apply to all document types.

## Fields to Extract

### Common to All Documents

| Field | Description | Where to Find It |
|-------|-------------|-----------------|
| `supplier` | Vendor/supplier name | Document header, top of page, "Från" / "Leverantör" |
| `amount` | Total amount **including VAT** | "Att betala", "Totalt inkl. moms", "Summa att betala" |
| `currency` | Currency code | Usually SEK. Look for explicit currency symbol. Default to SEK if unlabeled. |
| `vat_amount` | VAT in SEK | "Moms", "Varav moms", "Momssumma" — sum all VAT rows if multiple rates |

### Leverantörsfaktura Only

| Field | Description | Where to Find It |
|-------|-------------|-----------------|
| `due_date` | Payment due date | "Förfallodatum" — format as ISO 8601: YYYY-MM-DD |
| `ocr_number` | Payment reference | "OCR-nummer", "Betalningsreferens", "Referensnummer" |
| `bank_account` | Bank account to pay | "Bankgiro" (format: XXXXXX-X) or "Plusgiro" (format: XXXXX-X) — include the prefix (BG/PG) |

## Extraction Rules

- **Amount:** Extract the final payable total. If the document shows a subtotal and a total-with-VAT, use the total-with-VAT.
- **Currency:** Default to `SEK` if no currency is explicitly stated.
- **OCR number:** Copy the exact digits including any hyphens or spaces as printed. Do not interpret or recalculate it.
- **Bank account:** Include the type prefix. Example: `BG 123456-7` or `PG 12345-6`. Remove spaces if present to get canonical form: `1234567` for bankgiro.
- **VAT:** If multiple VAT rates are present (e.g. 25% and 12%), sum them for the `vat_amount` field.
- **Supplier:** Use the legal company name if visible. For SaaS/international suppliers, use the entity name on the invoice.

## Missing Fields

If a field cannot be found in the document:
- Leave it blank (do not guess)
- Note which fields are missing in your output

## Output Format

Return a structured summary:
```
supplier: Telia Sverige AB
amount: 1250.00
currency: SEK
due_date: 2026-04-15
ocr_number: 1234567890
bank_account: BG 123456-7
vat_amount: 250.00
```
