import path from 'node:path';
import { dispatchAndAwait, type DispatchOptions } from '../orchestrate.ts';
import type { Db } from '../db.ts';
import { DRIVE_FOLDER_MIME, findChildId, readDriveRootFolderId } from './finance.ts';
import {
  defaultGwsRunner,
  emptyMonthState,
  makeDriveDownloader,
  mergeDocument,
  parseStateMd,
  resolveStateFile,
  writeMonthState,
  type DriveDownloader,
  type GwsRunner,
  type LedgerDocument,
  type ProcessedMessage,
} from './state.ts';

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

// ---- filing (the Drive write half of the orchestrator) -----------------------

export interface FilingDeps {
  run?: GwsRunner;
  download?: DriveDownloader;
  rootFolderId?: () => string | null;
}

export interface FilingResult {
  ok: boolean;
  driveFileId?: string;
  detail: string;
}

/** Upload a local file to a Drive folder via the verified cwd-relative `+upload`. Returns its id. */
function uploadFile(folderId: string, localPath: string, name: string, run: GwsRunner): { ok: boolean; fileId: string; detail: string } {
  const res = run(
    ['drive', '+upload', path.basename(localPath), '--parent', folderId, '--name', name, '--format', 'json'],
    { cwd: path.dirname(localPath) },
  );
  if (!res.ok) return { ok: false, fileId: '', detail: res.detail };
  try {
    const j = JSON.parse(res.stdout) as { id?: string; file?: { id?: string } };
    const id = j.id ?? j.file?.id ?? '';
    return id ? { ok: true, fileId: id, detail: '' } : { ok: false, fileId: '', detail: 'upload returned no id' };
  } catch {
    return { ok: false, fileId: '', detail: 'upload returned non-JSON' };
  }
}

/**
 * File a classified document: upload its PDF to the type's Drive folder, then merge the row + the
 * Processed-Gmail row into `state.md` (collision-guarded). Idempotent via `mergeDocument`'s dedup, so a
 * retry re-files cleanly. Every resolution miss returns `ok:false` with a reason — never throws on a
 * Drive miss; the only throw is an auth failure surfacing from `writeMonthState` (a dead credential
 * must stop, not silently drop a verification).
 */
export function fileDocument(
  month: string,
  pdfPath: string,
  processed: ProcessedMessage,
  document: LedgerDocument,
  deps: FilingDeps = {},
): FilingResult {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return { ok: false, detail: 'no drive root folder id' };

  const monthId = findChildId(rootId, month, DRIVE_FOLDER_MIME, run);
  if (!monthId) return { ok: false, detail: `month folder ${month} not found` };
  const typeFolderName = document.drivePath.split('/').filter(Boolean).pop() ?? 'Verifikationer';
  const typeFolderId = findChildId(monthId, typeFolderName, DRIVE_FOLDER_MIME, run);
  if (!typeFolderId) return { ok: false, detail: `type folder ${typeFolderName} not found` };

  const up = uploadFile(typeFolderId, pdfPath, document.file, run);
  if (!up.ok) return { ok: false, detail: `upload failed: ${up.detail}` };

  const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!doppId) return { ok: false, detail: '.doppelganger folder not found' };
  const ref = resolveStateFile(doppId, run);
  const state = ref ? parseStateMd(download(ref.fileId)) : emptyMonthState(month);
  if (ref && state.month === '') return { ok: false, detail: 'state.md unreadable (corrupt download)' };

  const merged = mergeDocument(state, processed, { ...document, driveFileId: up.fileId });
  const w = writeMonthState(merged, doppId, ref, run);
  if (!w.ok) return { ok: false, detail: `state write ${w.reason}` };
  return { ok: true, driveFileId: up.fileId, detail: `filed ${document.file} → ${typeFolderName}/` };
}
