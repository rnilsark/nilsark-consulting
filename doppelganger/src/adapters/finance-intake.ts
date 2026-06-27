import { dispatchAndAwait, type DispatchOptions } from '../orchestrate.ts';
import type { Db } from '../db.ts';
import type { LedgerDocument } from './state.ts';

// The finance orchestrator's intake half: take ONE downloaded document, get its classification from
// the `classifier` judgment agent (LLM), then do the PROCEDURE in TS — normalize the amount, derive
// the payment status and Drive folder, assemble the ledger row. Filing it (Drive upload + state.md
// write) is the separate, still-gated cutover; this stops at "here is the row to file".

const TYPE_FOLDER: Record<string, string> = {
  leverantörsfaktura: 'Leverantörsfakturor',
  kvitto: 'Verifikationer',
  unknown: 'Verifikationer',
  kundfaktura: 'Kundfakturor',
  skattekonto: 'Skattekonto',
};
const UNPAID_TYPES = new Set(['leverantörsfaktura', 'skattekonto']);

/**
 * Normalize a Swedish-formatted amount to a plain dot-decimal string — the procedure the classifier
 * deliberately leaves alone (it returns the verbatim document text, e.g. `"2 513,00"`). Space/thin
 * thousands-separators are stripped; if a comma is present it is the decimal mark (dots are then
 * thousands separators); an amount with no comma is assumed already dot-decimal and passes through.
 * Empty stays empty.
 */
export function normalizeAmount(raw: string): string {
  const s = raw.trim().replace(/\s/g, '');
  if (s === '') return '';
  if (s.includes(',')) return s.replace(/\./g, '').replace(',', '.');
  return s;
}

/** The classifier's structured `result` (what `agents/classifier` returns). All fields optional. */
export interface Classification {
  type?: string;
  supplier?: string;
  amount?: string;
  currency?: string;
  vat_amount?: string;
  due_date?: string;
  ocr_number?: string;
  bank_account?: string;
  document_date?: string;
}

/**
 * Assemble a ledger row from the classifier's judgment + TS procedure. Pure: amounts normalized,
 * payment status + Drive folder derived from the type. `driveFileId` is left blank — it's set by the
 * (separate) upload step.
 */
export function documentFromClassification(filename: string, month: string, c: Classification): LedgerDocument {
  const type = c.type && c.type in TYPE_FOLDER ? c.type : 'unknown';
  return {
    file: filename,
    type,
    supplier: c.supplier ?? '',
    amount: normalizeAmount(c.amount ?? ''),
    currency: c.currency && c.currency.trim() ? c.currency : 'SEK',
    dueDate: c.due_date ?? '',
    documentDate: c.document_date ?? '',
    ocrNumber: c.ocr_number ?? '',
    bankAccount: c.bank_account ?? '',
    vatAmount: normalizeAmount(c.vat_amount ?? ''),
    drivePath: `${month}/${TYPE_FOLDER[type]}/`,
    driveFileId: '',
    paymentStatus: UNPAID_TYPES.has(type) ? 'unpaid' : 'n/a',
    fortnoxSent: 'no',
  };
}

export interface IntakeResult {
  status: 'classified' | 'flagged' | 'failed';
  document?: LedgerDocument;
  runId?: string;
  detail: string;
}

/**
 * Orchestrate one document end-to-judgment: dispatch the `classifier`, await its `result`, then
 * assemble the normalized ledger row. Does NOT file (no Drive write, no state write) — that's the
 * gated cutover step. Never throws; a non-success classifier run yields `status:'failed'`.
 */
export async function intakeDocument(
  db: Db,
  month: string,
  doc: { filePath: string; filename: string },
  opts: DispatchOptions = {},
): Promise<IntakeResult> {
  const r = await dispatchAndAwait(db, 'classifier', JSON.stringify(doc), opts);
  if (r.state !== 'done') return { status: 'failed', runId: r.runId, detail: `classifier did not finish (${r.state})` };
  if (r.status !== 'success' && r.status !== 'flagged') {
    return { status: 'failed', runId: r.runId, detail: `classifier ${r.status}` };
  }
  if (!r.result || typeof r.result !== 'object') {
    return { status: 'failed', runId: r.runId, detail: 'classifier returned no result' };
  }
  const document = documentFromClassification(doc.filename, month, r.result as Classification);
  return {
    status: r.status === 'flagged' ? 'flagged' : 'classified',
    document,
    runId: r.runId,
    detail: `classified ${doc.filename} as ${document.type}`,
  };
}
