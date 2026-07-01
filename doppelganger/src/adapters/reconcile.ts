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
  readLedgerState,
  writeLedgerState,
  type LedgerStoreDeps,
} from './ledger-store.ts';
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

// The reconcile orchestrator: match a bank statement against the open months' unpaid
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
      unmatchedReason: String(r.unmatched_reason ?? ''),
    };
  });
}

export interface ReconcileResult {
  status: 'reconciled' | 'no-matches' | 'failed';
  detail: string;
  matched: number;
  /** A human-readable Swedish breakdown of the reconciliation, for the operator push / chat review. Absent on failure. */
  summary?: string;
  runId?: string;
}

const SETTLED_CONFIDENCE = new Set(['exact', 'fuzzy', 'prior-month', 'manual']);

// ---- reconciliation summary (pure) ------------------------------------------
// A reviewable Swedish breakdown of a month's reconciliation, built purely from the persisted ledger
// (documents + bank rows) so the SAME function serves the reconcile-time push and the chat "review"
// pull. The point is to make an unmatched COUNT meaningful: the reconciler tags every unmatched row
// with a reason, so a scary "12 unmatched" splits into "10 expected (kvitton/lön/avgift/…) · 2 to
// check". Only the `okänd`/untagged rows are real work.

const TRACKED_TYPES = new Set(['leverantörsfaktura', 'skattekonto']);
/** Unmatched reasons that are expected forever and never settle an invoice — not gaps to chase. */
const EXPECTED_UNMATCHED = new Set(['kvitto', 'lön', 'avgift', 'skatt', 'inkommande']);

/** Canonicalize a reconciler reason tag; blank/unknown → 'okänd' (the needs-a-look bucket). */
function normReason(raw: string): string {
  const r = raw.trim().toLowerCase();
  if (r === 'lon') return 'lön';
  if (r === '' || r === 'okand') return 'okänd';
  return r;
}

/** Format a signed amount string as `-2 513 kr` (space thousands, no decimals). Deterministic (no ICU). */
function kr(amount: string): string {
  const n = Number(normalizeAmount(amount));
  if (!Number.isFinite(n)) return amount.trim();
  const whole = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${whole} kr`;
}

/**
 * Compose the Swedish reconciliation summary for one month from its ledger. Reports invoice coverage
 * (paid / total tracked), the still-unpaid invoices, and the unmatched bank rows split into "väntat"
 * (expected, grouped by reason) vs "att kolla" (okänd/untagged — the only real work). Pure.
 */
export function composeReconcileSummary(state: MonthState): string {
  const tracked = state.documents.filter((d) => TRACKED_TYPES.has(d.type));
  const paid = tracked.filter((d) => d.paymentStatus === 'paid');
  const unpaid = tracked.filter((d) => d.paymentStatus === 'unpaid' || d.paymentStatus === 'overdue');

  const bank = state.bank;
  const settledRows = bank.filter((b) => SETTLED_CONFIDENCE.has(b.matchConfidence) && b.matchedToFile);
  const outgoing = bank.filter((b) => Number(normalizeAmount(b.amount)) < 0);
  const unmatchedOut = outgoing.filter((b) => !(SETTLED_CONFIDENCE.has(b.matchConfidence) && b.matchedToFile));
  const incoming = bank.filter((b) => Number(normalizeAmount(b.amount)) > 0);

  const expected = unmatchedOut.filter((b) => EXPECTED_UNMATCHED.has(normReason(b.unmatchedReason)));
  const toCheck = unmatchedOut.filter((b) => !EXPECTED_UNMATCHED.has(normReason(b.unmatchedReason)));

  const lines: string[] = [`Avstämning ${state.month} (kontoutdrag)`, ''];

  lines.push(`Fakturor: ${paid.length}/${tracked.length} betalda`);
  if (unpaid.length) {
    lines.push(`Kvar att matcha (${unpaid.length}):`);
    for (const d of unpaid) lines.push(`- ${d.supplier} — ${kr(d.amount)}${d.dueDate ? ` — förf ${d.dueDate}` : ''}`);
  }
  lines.push('');

  lines.push(`Banktransaktioner: ${bank.length} rader, ${settledRows.length} matchade mot faktura`);
  lines.push(`Omatchade utgående (${unmatchedOut.length}):`);
  if (expected.length) {
    const byReason = new Map<string, number>();
    for (const b of expected) byReason.set(normReason(b.unmatchedReason), (byReason.get(normReason(b.unmatchedReason)) ?? 0) + 1);
    const parts = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`);
    lines.push(`  Väntat (${expected.length}): ${parts.join(' · ')}`);
  }
  if (toCheck.length) {
    lines.push(`  Att kolla (${toCheck.length}):`);
    for (const b of toCheck) lines.push(`  - ${b.date}  ${kr(b.amount)}  ${b.description || '(saknar referens)'}`);
  }
  if (unmatchedOut.length === 0) lines.push('  (inga)');
  if (incoming.length) lines.push(`Inkommande: ${incoming.length} rad(er)`);

  return lines.join('\n');
}

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
  deps: { dispatch?: DispatchOptions; filing?: FilingDeps; financeState?: LedgerStoreDeps; today?: string } = {},
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

  let fs = readLedgerState(deps.financeState) ?? { version: 2, periods: {} };
  let matched = 0;
  let periodState: MonthState | null = null;
  for (const m of touched) {
    const c = ctx.get(m);
    if (!c) continue;
    const paidFiles = paidByMonth.get(m) ?? new Set<string>();
    // The statement's own period gets the bank rows + paid marks; carry-over months get paid marks only.
    const newState = m === period ? applyReconciliation(c.state, transactions) : markDocsPaid(c.state, paidFiles);
    if (m === period) periodState = newState;
    const w = writeMonthState(newState, c.doppId, c.ref, run);
    if (!w.ok) return { status: 'failed', detail: `state write ${m} ${w.reason}`, matched: 0, runId: r.runId };
    matched += paidFiles.size;
    const paidDocs = c.state.documents.filter((d) => paidFiles.has(d.file)).map((d) => ({ supplier: d.supplier, amount: d.amount, dueDate: d.dueDate }));
    fs = markReconciled(fs, m, paidDocs);
  }
  writeLedgerState(fs, deps.financeState);

  return {
    status: matched > 0 ? 'reconciled' : 'no-matches',
    detail: `${period}: matched ${matched} invoice(s) across ${transactions.length} txns${touched.size > 1 ? ` (${touched.size} months)` : ''}`,
    matched,
    summary: periodState ? composeReconcileSummary(periodState) : undefined,
    runId: r.runId,
  };
}

// ---- review (read-only): compose the summary for an already-reconciled month ------------------------

/**
 * Load a month's ledger from Drive and compose its reconciliation summary — the pull side of the same
 * breakdown the reconcile push emits, for a chat "hur ligger avstämningen till?" query. When `month`
 * is omitted, picks the most recent of THIS_MONTH / last month that actually has bank rows (i.e. was
 * reconciled), falling back to the newest month that has a state.md. Read-only; never writes. null when
 * there's no Drive root or no open month with a state.md.
 */
export function reviewReconcile(
  month: string | undefined,
  deps: { filing?: FilingDeps; today?: string } = {},
): { month: string; summary: string } | null {
  const run = deps.filing?.run ?? defaultGwsRunner;
  const download = deps.filing?.download ?? makeDriveDownloader(run);
  const rootId = (deps.filing?.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return null;

  const today = deps.today ?? operatorToday();
  const candidates = month ? [month] : [today.slice(0, 7), prevMonth(today)];
  const loaded: MonthState[] = [];
  for (const m of candidates) {
    const monthId = findChildId(rootId, m, DRIVE_FOLDER_MIME, run);
    if (!monthId) continue;
    const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
    if (!doppId) continue;
    const ref = resolveStateFile(doppId, run);
    if (!ref) continue;
    const state = parseStateMd(download(ref.fileId));
    if (state.month === '') continue;
    loaded.push(state);
  }
  if (loaded.length === 0) return null;
  const chosen = loaded.find((s) => s.bank.length > 0) ?? loaded[0];
  return { month: chosen.month, summary: composeReconcileSummary(chosen) };
}

// ---- ledger read + write for chat (explain + correct) -------------------------

/** Resolve + parse one month's state.md, keeping the Drive refs so a caller can write it back. null on any miss. */
function loadMonthRef(
  month: string,
  rootId: string,
  run: GwsRunner,
  download: (id: string) => string,
): { state: MonthState; doppId: string; ref: ReturnType<typeof resolveStateFile> } | null {
  const monthId = findChildId(rootId, month, DRIVE_FOLDER_MIME, run);
  if (!monthId) return null;
  const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!doppId) return null;
  const ref = resolveStateFile(doppId, run);
  if (!ref) return null;
  const state = parseStateMd(download(ref.fileId));
  return state.month === '' ? null : { state, doppId, ref };
}

/**
 * A compact, read-only ledger view of the open months (THIS_MONTH + last month) for the chat LLM to
 * reason over — the "explain the books" context. Lists tracked invoices with their pay status, the
 * receipts, and the bank rows split into matched / unmatched-outgoing / incoming. Text, not JSON, so
 * it drops straight into the prompt. null when there's no Drive root or no open month with a state.md.
 */
export function financeLedgerSnapshot(deps: { filing?: FilingDeps; today?: string } = {}): string | null {
  const run = deps.filing?.run ?? defaultGwsRunner;
  const download = deps.filing?.download ?? makeDriveDownloader(run);
  const rootId = (deps.filing?.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return null;
  const today = deps.today ?? operatorToday();
  const months = [prevMonth(today), today.slice(0, 7)];

  const blocks: string[] = [];
  for (const m of months) {
    const loaded = loadMonthRef(m, rootId, run, download);
    if (!loaded) continue;
    const s = loaded.state;
    const lines = [`### ${m}${s.monthCloseSent === 'yes' ? ' (stängd)' : ' (öppen)'}`];

    const tracked = s.documents.filter((d) => TRACKED_TYPES.has(d.type));
    if (tracked.length) {
      lines.push('Fakturor/skatt:');
      for (const d of tracked) lines.push(`- [${d.paymentStatus}] ${d.supplier} — ${d.amount} ${d.currency}${d.dueDate ? ` — förf ${d.dueDate}` : ''} — ${d.file}`);
    }
    const receipts = s.documents.filter((d) => d.type === 'kvitto');
    if (receipts.length) lines.push(`Kvitton: ${receipts.map((d) => `${d.supplier} ${d.amount}`).join(' · ')}`);

    const settled = s.bank.filter((b) => SETTLED_CONFIDENCE.has(b.matchConfidence) && b.matchedToFile);
    const unmatchedOut = s.bank.filter((b) => Number(normalizeAmount(b.amount)) < 0 && !(SETTLED_CONFIDENCE.has(b.matchConfidence) && b.matchedToFile));
    const incoming = s.bank.filter((b) => Number(normalizeAmount(b.amount)) > 0);
    if (s.bank.length) {
      lines.push(`Bank: ${s.bank.length} rader, ${settled.length} matchade`);
      if (settled.length) lines.push(`  Matchade: ${settled.map((b) => `${b.description} ${b.amount} → ${b.matchedToFile}`).join(' · ')}`);
      if (unmatchedOut.length) lines.push(`  Omatchat utgående: ${unmatchedOut.map((b) => `${b.date} ${b.description} ${b.amount}${b.unmatchedReason ? ` [${b.unmatchedReason}]` : ''}`).join(' · ')}`);
      if (incoming.length) lines.push(`  Inkommande: ${incoming.map((b) => `${b.description} ${b.amount}`).join(' · ')}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

export interface LedgerCorrection {
  /** the month to correct; when absent, search THIS_MONTH then last month for the target doc. */
  month?: string;
  /** exact `file` of the target document (preferred), OR ... */
  file?: string;
  /** ... a case-insensitive supplier substring (first tracked match wins). */
  supplier?: string;
  /** flip the document's payment status to `paid`. */
  setPaid?: boolean;
  /** overwrite the document's due date (YYYY-MM-DD) — for fixing a mis-parsed date. */
  dueDate?: string;
  /** link the bank row whose description contains this text to the doc (confidence `manual`). */
  linkBankDescription?: string;
}

export interface CorrectionResult {
  ok: boolean;
  month?: string;
  file?: string;
  detail: string;
}

/**
 * Apply an operator-directed ledger correction to state.md — the write side of the chat "correction"
 * loop (chat reads the snapshot, the operator confirms a fix, chat orders this). Resolves the target
 * document by `file` (exact) or `supplier` (substring) across the open months, applies the requested
 * changes (set paid / fix due date / manually link a bank row), and writes the month back. Never
 * touches Gmail or payments. Best-effort: a Drive miss returns `{ ok:false }`, not a throw.
 */
export function applyLedgerCorrection(c: LedgerCorrection, deps: { filing?: FilingDeps; today?: string } = {}): CorrectionResult {
  const run = deps.filing?.run ?? defaultGwsRunner;
  const download = deps.filing?.download ?? makeDriveDownloader(run);
  const rootId = (deps.filing?.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return { ok: false, detail: 'no drive root folder id' };
  if (!c.file && !c.supplier) return { ok: false, detail: 'need a file or supplier to correct' };

  const today = deps.today ?? operatorToday();
  const months = c.month ? [c.month] : [today.slice(0, 7), prevMonth(today)];
  const needle = c.supplier?.trim().toLowerCase() ?? '';

  for (const m of months) {
    const loaded = loadMonthRef(m, rootId, run, download);
    if (!loaded) continue;
    const idx = loaded.state.documents.findIndex((d) =>
      c.file ? d.file === c.file : TRACKED_TYPES.has(d.type) && d.supplier.toLowerCase().includes(needle),
    );
    if (idx < 0) continue;

    const changes: string[] = [];
    const documents = loaded.state.documents.map((d, i) => {
      if (i !== idx) return d;
      let nd = d;
      if (c.setPaid && nd.paymentStatus !== 'paid') { nd = { ...nd, paymentStatus: 'paid' }; changes.push('betald'); }
      if (c.dueDate && nd.dueDate !== c.dueDate) { nd = { ...nd, dueDate: c.dueDate }; changes.push(`förf → ${c.dueDate}`); }
      return nd;
    });
    const targetFile = documents[idx].file;

    let bank = loaded.state.bank;
    if (c.linkBankDescription) {
      const bneedle = c.linkBankDescription.trim().toLowerCase();
      let linked = false;
      bank = bank.map((b) => {
        if (!linked && b.description.toLowerCase().includes(bneedle)) { linked = true; changes.push(`bankrad ${b.description} kopplad`); return { ...b, matchedToFile: targetFile, matchConfidence: 'manual', unmatchedReason: '' }; }
        return b;
      });
    }
    if (changes.length === 0) return { ok: true, month: m, file: targetFile, detail: 'inget att ändra (redan så)' };

    const w = writeMonthState({ ...loaded.state, documents, bank }, loaded.doppId, loaded.ref, run);
    if (!w.ok) return { ok: false, month: m, file: targetFile, detail: `state write ${w.reason}` };
    return { ok: true, month: m, file: targetFile, detail: changes.join(', ') };
  }
  return { ok: false, detail: `hittade ingen post för ${c.file ?? c.supplier}` };
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
