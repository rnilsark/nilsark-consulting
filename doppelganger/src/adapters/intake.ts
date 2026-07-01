import path from 'node:path';
import { dispatchAndAwait, type DispatchOptions } from '../orchestrate.ts';
import type { Db } from '../db.ts';
import {
  DRIVE_FOLDER_MIME,
  ensureChildFolder,
  findChildId,
  operatorToday,
  projectNotifyItem,
  readDriveRootFolderId,
  readFinanceStateFromDrive,
  writeFinanceStateToDrive,
  type DriveStateDeps,
} from './finance.ts';
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
// the payment status and Drive folder, assemble the ledger row, and file it (Drive upload + state.md
// write). `runIntake` is the full path the `intake` worker runs in place of a whole entrepreneur LLM run.

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

/**
 * Upload a local file to a Drive folder via the verified cwd-relative `+upload`. Returns its id.
 * Idempotent: `+upload` always CREATES a new file, so a re-file (retry, sweep re-processing) would
 * duplicate. If a file with this name already sits in the folder, reuse its id instead of uploading.
 */
function uploadFile(folderId: string, localPath: string, name: string, run: GwsRunner): { ok: boolean; fileId: string; detail: string } {
  const existing = findChildId(folderId, name, null, run);
  if (existing) return { ok: true, fileId: existing, detail: 'reused existing upload' };
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

  // Scaffold on demand: create the month, type, and .doppelganger folders if they don't exist yet,
  // so a new month (or a month someone only partially built) never hard-fails intake.
  const monthId = ensureChildFolder(rootId, month, run);
  if (!monthId) return { ok: false, detail: `could not resolve/create month folder ${month}` };
  const typeFolderName = document.drivePath.split('/').filter(Boolean).pop() ?? 'Verifikationer';
  const typeFolderId = ensureChildFolder(monthId, typeFolderName, run);
  if (!typeFolderId) return { ok: false, detail: `could not resolve/create type folder ${typeFolderName}` };

  const up = uploadFile(typeFolderId, pdfPath, document.file, run);
  if (!up.ok) return { ok: false, detail: `upload failed: ${up.detail}` };

  const doppId = ensureChildFolder(monthId, '.doppelganger', run);
  if (!doppId) return { ok: false, detail: 'could not resolve/create .doppelganger folder' };
  const ref = resolveStateFile(doppId, run);
  const state = ref ? parseStateMd(download(ref.fileId)) : emptyMonthState(month);
  if (ref && state.month === '') return { ok: false, detail: 'state.md unreadable (corrupt download)' };

  const merged = mergeDocument(state, processed, { ...document, driveFileId: up.fileId });
  const w = writeMonthState(merged, doppId, ref, run);
  if (!w.ok) return { ok: false, detail: `state write ${w.reason}` };
  return { ok: true, driveFileId: up.fileId, detail: `filed ${document.file} → ${typeFolderName}/` };
}

// ---- the orchestrator entry point -------------------------------------------

export interface IntakeDoc {
  filePath: string;
  filename: string;
  messageId: string;
  from: string;
  date: string;
  subject: string;
}

export interface RunIntakeResult {
  status: 'filed' | 'classify-failed' | 'file-failed';
  detail: string;
  driveFileId?: string;
  runId?: string;
}

/**
 * The month to actually file into. A doc's home month is its document-date month — but if that month
 * is already CLOSED (month-close sent) or LEGACY (a pre-migration `.nilsark` month the new writer can't
 * own), we must not reopen it; book into the current processing month instead. A month that doesn't
 * exist yet, or is a normal open `.doppelganger` month, is used as-is (fileDocument scaffolds it).
 */
export function resolveWritableMonth(homeMonth: string, currentMonth: string, filing: FilingDeps): string {
  if (homeMonth === currentMonth) return homeMonth;
  const run = filing.run ?? defaultGwsRunner;
  const rootId = (filing.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return homeMonth;
  const monthId = findChildId(rootId, homeMonth, DRIVE_FOLDER_MIME, run);
  if (!monthId) return homeMonth; // fresh month → scaffold it, don't divert
  if (findChildId(monthId, '.nilsark', DRIVE_FOLDER_MIME, run)) return currentMonth; // legacy month
  const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (doppId) {
    const ref = resolveStateFile(doppId, run);
    if (ref) {
      const download = filing.download ?? makeDriveDownloader(run);
      const state = parseStateMd(download(ref.fileId));
      if (state.monthCloseSent === 'yes') return currentMonth; // closed month
    }
  }
  return homeMonth;
}

/**
 * The finance orchestrator's full intake of one document: classify (judgment agent) → normalize +
 * assemble the row (TS) → upload + merge into state.md (TS). This is what the inbox path calls (via the
 * `intake` worker) in place of a whole entrepreneur LLM run. A flagged classification still files the doc but marks the
 * Processed-Gmail row `error` (so a future sweep revisits it). Never throws on a Drive miss.
 */
export async function runIntake(
  db: Db,
  month: string,
  doc: IntakeDoc,
  deps: { dispatch?: DispatchOptions; filing?: FilingDeps; financeState?: DriveStateDeps } = {},
): Promise<RunIntakeResult> {
  const ir = await intakeDocument(db, month, { filePath: doc.filePath, filename: doc.filename }, deps.dispatch);
  if (ir.status === 'failed' || !ir.document) {
    return { status: 'classify-failed', detail: ir.detail, runId: ir.runId };
  }
  // File into the month the document's own date belongs to (a late-June invoice arriving in July
  // lands in June), falling back to the caller's month when the date is unreadable — then divert away
  // from a closed/legacy month to the current one. Rewrite drive_path so the ledger names the month
  // we actually file into (not the caller's month).
  const homeMonth = /^\d{4}-\d{2}/.test(ir.document.documentDate) ? ir.document.documentDate.slice(0, 7) : month;
  const fileMonth = resolveWritableMonth(homeMonth, operatorToday().slice(0, 7), deps.filing ?? {});
  const typeFolder = ir.document.drivePath.split('/').filter(Boolean).pop() ?? 'Verifikationer';
  ir.document = { ...ir.document, drivePath: `${fileMonth}/${typeFolder}/` };
  const processed: ProcessedMessage = {
    messageId: doc.messageId,
    date: doc.date,
    from: doc.from,
    subject: doc.subject,
    attachmentFilename: doc.filename,
    status: ir.status === 'flagged' ? 'error' : 'classified',
  };
  const fr = fileDocument(fileMonth, doc.filePath, processed, ir.document, deps.filing);
  if (!fr.ok) return { status: 'file-failed', detail: fr.detail, runId: ir.runId };

  // Project an unpaid invoice into the gate's state.json (notify.items, fingerprint left stale) so the
  // skip-gate surfaces it. A failure here doesn't un-file the doc — the ledger is the record of truth,
  // and the weekly backstop still catches an item the gate didn't learn about. Best-effort.
  let gateNote = '';
  const projected = projectNotifyItem(readFinanceStateFromDrive(deps.financeState) ?? { version: 2, periods: {} }, fileMonth, ir.document, operatorToday());
  const wj = writeFinanceStateToDrive(projected, deps.financeState);
  if (!wj.ok) gateNote = ` (state.json not updated: ${wj.detail})`;

  return { status: 'filed', detail: `${fr.detail}${gateNote}`, driveFileId: fr.driveFileId, runId: ir.runId };
}
