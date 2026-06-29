import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dispatchAndAwait, type DispatchOptions } from '../orchestrate.ts';
import { config } from '../config.ts';
import { getChannelCursor, insertOutbox, insertQueue, operatorPushTarget, setChannelCursor, type Db } from '../db.ts';
import {
  DRIVE_FOLDER_MIME,
  findChildId,
  markReconciled,
  operatorToday,
  prevMonth,
  projectNotifyItem,
  readDriveRootFolderId,
  readFinanceStateFromDrive,
  writeFinanceStateToDrive,
  type DriveStateDeps,
} from './finance.ts';
import {
  applyReconciliation,
  defaultGwsRunner,
  emptyMonthState,
  makeDriveDownloader,
  mergeDocument,
  parseStateMd,
  resolveStateFile,
  writeMonthState,
  type BankTransaction,
  type DriveDownloader,
  type GwsRunner,
  type LedgerDocument,
  type ProcessedMessage,
} from './state.ts';
import { defaultGmailSweep, selectNewMessages, type GmailSweep } from './inbox.ts';

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
  // lands in June), falling back to the caller's month when the date is unreadable.
  const fileMonth = /^\d{4}-\d{2}/.test(ir.document.documentDate) ? ir.document.documentDate.slice(0, 7) : month;
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

// ---- reconcile orchestrator -------------------------------------------------

/** Map the reconciler's snake_case result rows to BankTransaction, normalizing amounts. */
function normalizeTransactions(raw: unknown): BankTransaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const r = t as Record<string, unknown>;
    return {
      date: String(r.date ?? ''),
      description: String(r.description ?? ''),
      amount: normalizeAmount(String(r.amount ?? '')),
      currency: String(r.currency ?? 'SEK') || 'SEK',
      matchedToFile: String(r.matched_to_file ?? ''),
      matchConfidence: String(r.match_confidence ?? 'unmatched'),
    };
  });
}

export interface ReconcileResult {
  status: 'reconciled' | 'no-matches' | 'failed';
  detail: string;
  matched: number;
  runId?: string;
}

/**
 * Reconcile one bank statement against `month`'s unpaid invoices: read the ledger, dispatch the
 * `reconciler` (judgment) with the unpaid set, apply (mark paid + record txns) to state.md, then mark
 * the period reconciled + drop paid items from state.json. Mirrors runIntake; never throws on a Drive
 * miss. The statement file is already on local disk (downloaded by the reconcile worker).
 */
export async function runReconcile(
  db: Db,
  month: string,
  statement: { filePath: string; filename: string },
  deps: { dispatch?: DispatchOptions; filing?: FilingDeps; financeState?: DriveStateDeps } = {},
): Promise<ReconcileResult> {
  const run = deps.filing?.run ?? defaultGwsRunner;
  const download = deps.filing?.download ?? makeDriveDownloader(run);
  const rootId = (deps.filing?.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return { status: 'failed', detail: 'no drive root folder id', matched: 0 };
  const monthId = findChildId(rootId, month, DRIVE_FOLDER_MIME, run);
  if (!monthId) return { status: 'failed', detail: `month folder ${month} not found`, matched: 0 };
  const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!doppId) return { status: 'failed', detail: 'no .doppelganger folder', matched: 0 };
  const ref = resolveStateFile(doppId, run);
  if (!ref) return { status: 'failed', detail: `no state.md for ${month}`, matched: 0 };
  const state = parseStateMd(download(ref.fileId));
  if (state.month === '') return { status: 'failed', detail: 'state.md unreadable', matched: 0 };

  const unpaid = state.documents.filter(
    (d) => (d.type === 'leverantörsfaktura' || d.type === 'skattekonto') && (d.paymentStatus === 'unpaid' || d.paymentStatus === 'overdue'),
  );
  const invoices = unpaid.map((d) => ({
    file: d.file, supplier: d.supplier, amount: d.amount, ocr_number: d.ocrNumber, due_date: d.dueDate, type: d.type,
  }));

  const r = await dispatchAndAwait(
    db,
    'reconciler',
    JSON.stringify({ statementPath: statement.filePath, filename: statement.filename, invoices }),
    deps.dispatch,
  );
  if (r.state !== 'done' || (r.status !== 'success' && r.status !== 'flagged') || !r.result) {
    return { status: 'failed', detail: `reconciler ${r.state}/${r.status ?? '?'}`, matched: 0, runId: r.runId };
  }

  const transactions = normalizeTransactions((r.result as { transactions?: unknown }).transactions);
  const applied = applyReconciliation(state, transactions);
  const w = writeMonthState(applied, doppId, ref, run);
  if (!w.ok) return { status: 'failed', detail: `state write ${w.reason}`, matched: 0, runId: r.runId };

  const paidFiles = new Set(
    transactions.filter((t) => (t.matchConfidence === 'exact' || t.matchConfidence === 'fuzzy') && t.matchedToFile).map((t) => t.matchedToFile),
  );
  const paidDocs = unpaid.filter((d) => paidFiles.has(d.file)).map((d) => ({ supplier: d.supplier, amount: d.amount, dueDate: d.dueDate }));
  const fs = readFinanceStateFromDrive(deps.financeState) ?? { version: 2, periods: {} };
  writeFinanceStateToDrive(markReconciled(fs, month, paidDocs), deps.financeState);

  const matched = paidFiles.size;
  return {
    status: matched > 0 ? 'reconciled' : 'no-matches',
    detail: `${month}: matched ${matched}/${unpaid.length} invoices across ${transactions.length} txns`,
    matched,
    runId: r.runId,
  };
}

// ---- Drive drop folder → reconcile ------------------------------------------

/** Download a Drive file's bytes to `destPath` (raw — handles both the -o-file and stdout cases). */
export function downloadDriveFileToPath(fileId: string, destPath: string, run: GwsRunner = defaultGwsRunner): boolean {
  const res = run(['drive', 'files', 'get', '--params', JSON.stringify({ fileId, alt: 'media' }), '-o', path.basename(destPath)], { cwd: path.dirname(destPath) });
  if (!res.ok) return false;
  if (existsSync(destPath)) return true; // gws wrote the file (PDF/binary case)
  try {
    writeFileSync(destPath, res.stdout); // gws streamed to stdout (text/csv/json case)
    return true;
  } catch {
    return false;
  }
}

export interface BankDropDeps {
  run?: GwsRunner;
  rootFolderId?: () => string | null;
  folderName?: string;
}

/**
 * Poll the Drive "drop" folder for bank statements uploaded straight to Drive (no self-email). Each
 * new file enqueues a `reconcile` run carrying its `driveFileId`. Dedup is a processed-id set in
 * `channel_state` (key `bankdrop`), so a statement is enqueued once. Missing folder / gws error → 0.
 */
export function pollBankDrop(db: Db, deps: BankDropDeps = {}): { enqueued: number } {
  const run = deps.run ?? defaultGwsRunner;
  const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return { enqueued: 0 };
  const folderId = findChildId(rootId, deps.folderName ?? config.bankDropFolder, DRIVE_FOLDER_MIME, run);
  if (!folderId) return { enqueued: 0 }; // drop folder not created yet → nothing to do
  const res = run(['drive', 'files', 'list', '--params', JSON.stringify({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(id,name,mimeType)' }), '--format', 'json']);
  if (!res.ok) return { enqueued: 0 };
  let files: Array<{ id?: string; name?: string; mimeType?: string }>;
  try {
    files = (JSON.parse(res.stdout) as { files?: typeof files }).files ?? [];
  } catch {
    return { enqueued: 0 };
  }
  let processed: string[];
  try {
    processed = JSON.parse(getChannelCursor(db, 'bankdrop') ?? '[]') as string[];
  } catch {
    processed = [];
  }
  const seen = new Set(processed);
  let enqueued = 0;
  for (const f of files) {
    if (!f.id || f.mimeType === DRIVE_FOLDER_MIME || seen.has(f.id)) continue;
    insertQueue(db, { agent: 'reconcile', task: JSON.stringify({ driveFileId: f.id, filename: f.name ?? 'statement' }), parent: null });
    seen.add(f.id);
    enqueued++;
  }
  if (enqueued > 0) setChannelCursor(db, 'bankdrop', JSON.stringify([...seen]));
  return { enqueued };
}

// ---- daily catch-all sweep (the entrepreneur's old collect step, in TS) -----

export interface SweepDeps {
  sweep?: GmailSweep;
  run?: GwsRunner;
  download?: DriveDownloader;
  rootFolderId?: () => string | null;
  today?: string;
}

/** A daily backstop should only ever turn up a handful of missed messages. More than this means the
 *  dedup basis is broken (a Drive hiccup), not that the mailbox really has that many unfiled docs — so
 *  the sweep refuses to enqueue rather than risk a re-processing storm. */
const SWEEP_MAX_ENQUEUE = 25;

/**
 * message-ids already filed (state.md) or already on the queue — so the sweep never re-enqueues one.
 * Returns `null` when the filed-set can't be trusted (no root folder, or a state.md that resolves but
 * won't parse): the caller then skips the sweep entirely rather than flood the queue with re-fetches.
 */
function alreadySeenMessageIds(
  db: Db,
  months: string[],
  run: GwsRunner,
  download: DriveDownloader,
  rootFolderId: () => string | null,
): Set<string> | null {
  const seen = new Set<string>();
  // (a) on the queue right now (enqueued by the cursor poll but not yet filed) — any inbox/intake/reconcile row.
  const rows = db.prepare(`SELECT task FROM queue WHERE agent IN ('inbox','intake','reconcile')`).all() as Array<{ task: string }>;
  for (const r of rows) {
    try {
      const id = (JSON.parse(r.task) as { messageId?: string }).messageId;
      if (id) seen.add(id);
    } catch {
      // a non-JSON task carries no messageId — nothing to dedup on
    }
  }
  // (b) already filed: Processed-Gmail ids (classified / skipped) in the in-scope months' state.md.
  const rootId = rootFolderId();
  if (!rootId) return null; // can't prove what's filed → unsafe to sweep
  for (const m of months) {
    const monthId = findChildId(rootId, m, DRIVE_FOLDER_MIME, run);
    if (!monthId) continue; // month folder not created yet → legitimately nothing filed there
    const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
    if (!doppId) continue;
    const ref = resolveStateFile(doppId, run);
    if (!ref) continue; // no state.md yet → nothing filed for this month
    const state = parseStateMd(download(ref.fileId));
    if (state.month === '') return null; // state.md is THERE but unreadable → don't trust the dedup, skip
    for (const p of state.processed) {
      if (p.status === 'classified' || p.status.startsWith('skipped')) seen.add(p.messageId);
    }
  }
  return seen;
}

/**
 * The daily collect backstop (TS, no LLM) — the work the entrepreneur's `collect-finance` skill used to
 * do. List every attachment-bearing inbox message since the start of LAST month, drop any already filed
 * (state.md) or already queued (the cursor poll), and enqueue one metadata-only `inbox` row per
 * remaining message — the same shape `ingestInbox` enqueues, so the haiku gate routes each to
 * intake/reconcile. The 15-minute cursor poll is the fast primary; this is the once-daily insurance for
 * anything it missed (an outage, a watermark gap). Best-effort: a Drive/Gmail miss yields 0, never throws.
 */
export function sweepFinanceInbox(db: Db, deps: SweepDeps = {}): { enqueued: number } {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const rootFolderId = deps.rootFolderId ?? readDriveRootFolderId;
  const today = deps.today ?? operatorToday();
  const months = [prevMonth(today), today.slice(0, 7)];
  const firstDay = `${months[0]}-01`;

  const messages = (deps.sweep ?? defaultGmailSweep)(firstDay);
  if (messages.length === 0) return { enqueued: 0 };

  const seen = alreadySeenMessageIds(db, months, run, download, rootFolderId);
  if (seen === null) {
    console.error('[intake-sweep] skipped — could not establish the filed-set (Drive read failed)');
    return { enqueued: 0 };
  }
  const fresh = selectNewMessages(messages, seen);
  if (fresh.length > SWEEP_MAX_ENQUEUE) {
    console.error(`[intake-sweep] skipped — ${fresh.length} candidates exceeds cap ${SWEEP_MAX_ENQUEUE}; dedup basis likely broken`);
    return { enqueued: 0 };
  }
  let enqueued = 0;
  for (const msg of fresh) {
    insertQueue(db, {
      agent: 'inbox',
      task: JSON.stringify({
        messageId: msg.messageId,
        from: msg.from,
        subject: msg.subject,
        snippet: msg.snippet,
        attachments: msg.attachments,
      }),
      parent: null,
    });
    enqueued++;
  }
  if (enqueued > 0) console.log(`[intake-sweep] enqueued ${enqueued} message(s) → inbox`);
  return { enqueued };
}

// ---- month-start nudge ------------------------------------------------------

export interface NudgeDeps {
  today?: string;
  financeState?: DriveStateDeps;
}

/**
 * Early each month, if LAST month isn't reconciled yet and no statement has arrived, push the operator
 * once: "drop last month's statement in the Drive folder." Human-in-loop only when actually needed.
 * Self-gating: only the first 7 days of the month, and deduped (one nudge per period, via
 * channel_state `banknudge`). Pushes nothing if there's no operator push target.
 */
export function bankStatementNudge(db: Db, deps: NudgeDeps = {}): { nudged: boolean; detail: string } {
  const today = deps.today ?? operatorToday();
  if (Number(today.slice(8, 10)) > 7) return { nudged: false, detail: 'not the start of the month' };
  const period = prevMonth(today);
  if (getChannelCursor(db, 'banknudge') === period) return { nudged: false, detail: `already nudged for ${period}` };

  const fs = readFinanceStateFromDrive(deps.financeState);
  if (fs?.periods?.[period]?.export_status === 'reconciled') {
    setChannelCursor(db, 'banknudge', period); // mark so we don't recheck all month
    return { nudged: false, detail: `${period} already reconciled` };
  }

  const target = config.operatorNumber ? operatorPushTarget(db, config.operatorNumber) : null;
  if (target) {
    insertOutbox(db, {
      channel: target.channel,
      conversation_id: target.conversationId,
      text: `Dags att stämma av ${period}. Ladda upp månadens kontoutdrag till Drive-mappen "${config.bankDropFolder}" så sköter jag resten.`,
    });
  }
  setChannelCursor(db, 'banknudge', period);
  return { nudged: !!target, detail: target ? `nudged for ${period}` : `would nudge for ${period} (no push target)` };
}
