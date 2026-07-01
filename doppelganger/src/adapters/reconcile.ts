import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dispatchAndAwait, type DispatchOptions } from '../orchestrate.ts';
import { config } from '../config.ts';
import { getChannelCursor, insertQueue, setChannelCursor, type Db } from '../db.ts';
import {
  DRIVE_FOLDER_MIME,
  findChildId,
  markReconciled,
  operatorToday,
  prevMonth,
  readDriveRootFolderId,
  readFinanceStateFromDrive,
  writeFinanceStateToDrive,
  type DriveStateDeps,
} from './finance.ts';
import {
  applyReconciliation,
  defaultGwsRunner,
  makeDriveDownloader,
  parseStateMd,
  resolveStateFile,
  writeMonthState,
  type BankTransaction,
  type GwsRunner,
  type MonthState,
} from './state.ts';
import { normalizeAmount, type FilingDeps } from './intake.ts';

// The finance orchestrator's reconcile half: match a bank statement against the open months' unpaid
// invoices (via the `reconciler` judgment agent), then apply the settled matches to the right month.
// Plus `pollBankDrop`, which turns a statement dropped straight into the Drive folder into a run.

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

const SETTLED_CONFIDENCE = new Set(['exact', 'fuzzy', 'prior-month']);

/** The dominant YYYY-MM among the transactions' dates — the month the statement actually covers. */
function inferPeriod(transactions: BankTransaction[]): string | null {
  const counts = new Map<string, number>();
  for (const t of transactions) {
    const m = t.date.slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  for (const [m, c] of counts) if (c > most) { best = m; most = c; }
  return best;
}

/** Flip the given files to `paid` in a month's ledger, without recording bank rows (carry-over case). */
function markDocsPaid(state: MonthState, files: Set<string>): MonthState {
  if (files.size === 0) return state;
  return { ...state, documents: state.documents.map((d) => (files.has(d.file) ? { ...d, paymentStatus: 'paid' } : d)) };
}

/**
 * Reconcile one bank statement WITHOUT being told which month it is — the statement's own transaction
 * dates decide. Loads the unpaid invoices from a two-month candidate window (THIS_MONTH + last month,
 * the only realistic periods), hands the union to the `reconciler` (judgment), then applies its matches
 * to the RIGHT month per matched invoice: bank rows are recorded in the statement's detected period;
 * an invoice is marked paid in whichever month it lives (so a statement paying a prior-month straggler
 * settles it there). state.json `export_status` is set `reconciled` for every touched month. Never
 * assumes prevMonth; never throws on a Drive miss. The file is already on local disk.
 */
export async function runReconcile(
  db: Db,
  statement: { filePath: string; filename: string },
  deps: { dispatch?: DispatchOptions; filing?: FilingDeps; financeState?: DriveStateDeps; today?: string } = {},
): Promise<ReconcileResult> {
  const run = deps.filing?.run ?? defaultGwsRunner;
  const download = deps.filing?.download ?? makeDriveDownloader(run);
  const rootId = (deps.filing?.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return { status: 'failed', detail: 'no drive root folder id', matched: 0 };

  const today = deps.today ?? operatorToday();
  const candidates = [today.slice(0, 7), prevMonth(today)]; // THIS_MONTH + last month
  const ctx = new Map<string, { state: MonthState; doppId: string; ref: ReturnType<typeof resolveStateFile> }>();
  const fileMonth = new Map<string, string>();
  const invoices: Array<{ file: string; supplier: string; amount: string; ocr_number: string; due_date: string; type: string }> = [];
  for (const m of candidates) {
    const monthId = findChildId(rootId, m, DRIVE_FOLDER_MIME, run);
    if (!monthId) continue;
    const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
    if (!doppId) continue;
    const ref = resolveStateFile(doppId, run);
    if (!ref) continue;
    const state = parseStateMd(download(ref.fileId));
    if (state.month === '') continue;
    ctx.set(m, { state, doppId, ref });
    for (const d of state.documents) {
      if ((d.type === 'leverantörsfaktura' || d.type === 'skattekonto') && (d.paymentStatus === 'unpaid' || d.paymentStatus === 'overdue')) {
        invoices.push({ file: d.file, supplier: d.supplier, amount: d.amount, ocr_number: d.ocrNumber, due_date: d.dueDate, type: d.type });
        fileMonth.set(d.file, m);
      }
    }
  }
  if (ctx.size === 0) return { status: 'failed', detail: 'no open month with a state.md', matched: 0 };

  // The reconciler reads a whole PDF statement and matches every open invoice against it — the
  // slowest judgment run by far (multiple minutes). The default 180s await times out mid-run and
  // throws the (already-computed) result away, so give it real headroom. A caller can still override.
  const r = await dispatchAndAwait(
    db,
    'reconciler',
    JSON.stringify({ statementPath: statement.filePath, filename: statement.filename, invoices }),
    { timeoutMs: 600_000, ...deps.dispatch },
  );
  if (r.state !== 'done' || (r.status !== 'success' && r.status !== 'flagged') || !r.result) {
    return { status: 'failed', detail: `reconciler ${r.state}/${r.status ?? '?'}`, matched: 0, runId: r.runId };
  }
  const result = r.result as { transactions?: unknown; period?: unknown };
  const transactions = normalizeTransactions(result.transactions);

  // The statement's period: trust the kernel's reading, else infer from the txn dates, else newest candidate.
  const reported = typeof result.period === 'string' && /^\d{4}-\d{2}$/.test(result.period) ? result.period : null;
  const period = reported ?? inferPeriod(transactions) ?? candidates.find((m) => ctx.has(m)) ?? candidates[0];

  // Group settled matches by the month their invoice lives in.
  const paidByMonth = new Map<string, Set<string>>();
  for (const t of transactions) {
    if (!SETTLED_CONFIDENCE.has(t.matchConfidence) || !t.matchedToFile) continue;
    const m = fileMonth.get(t.matchedToFile);
    if (!m) continue;
    let set = paidByMonth.get(m);
    if (!set) { set = new Set<string>(); paidByMonth.set(m, set); }
    set.add(t.matchedToFile);
  }

  const touched = new Set<string>([...paidByMonth.keys()]);
  if (ctx.has(period)) touched.add(period); // record the statement even if it matched nothing

  let fs = readFinanceStateFromDrive(deps.financeState) ?? { version: 2, periods: {} };
  let matched = 0;
  for (const m of touched) {
    const c = ctx.get(m);
    if (!c) continue;
    const paidFiles = paidByMonth.get(m) ?? new Set<string>();
    // The statement's own period gets the bank rows + paid marks; carry-over months get paid marks only.
    const newState = m === period ? applyReconciliation(c.state, transactions) : markDocsPaid(c.state, paidFiles);
    const w = writeMonthState(newState, c.doppId, c.ref, run);
    if (!w.ok) return { status: 'failed', detail: `state write ${m} ${w.reason}`, matched: 0, runId: r.runId };
    matched += paidFiles.size;
    const paidDocs = c.state.documents.filter((d) => paidFiles.has(d.file)).map((d) => ({ supplier: d.supplier, amount: d.amount, dueDate: d.dueDate }));
    fs = markReconciled(fs, m, paidDocs);
  }
  writeFinanceStateToDrive(fs, deps.financeState);

  return {
    status: matched > 0 ? 'reconciled' : 'no-matches',
    detail: `${period}: matched ${matched} invoice(s) across ${transactions.length} txns${touched.size > 1 ? ` (${touched.size} months)` : ''}`,
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
    insertQueue(db, { agent: 'statement', task: JSON.stringify({ driveFileId: f.id, filename: f.name ?? 'statement' }), parent: null });
    seen.add(f.id);
    enqueued++;
  }
  if (enqueued > 0) setChannelCursor(db, 'bankdrop', JSON.stringify([...seen]));
  return { enqueued };
}
