// The finance heartbeat's JUDGMENT-LESS rollup, in TypeScript — the work the `entrepreneur` LLM run
// used to do once collection was peeled off it. None of it is judgment: marking overdue is a date
// compare, the actionable set is a filter, the notify-items + fingerprint are a pinned contract
// (`finance.ts` already recomputes the fingerprint byte-for-byte), and the anomaly flags are fixed
// rules. So it lives here as deterministic, unit-tested code, and the `finance` orchestrator-star runs
// it instead of paying for an LLM. Pure functions over the parsed `MonthState` + `state.json`; Drive
// I/O is the orchestrator's job (kept out of here so this stays trivially testable).

import {
  DRIVE_FOLDER_MIME,
  bucketFor,
  computeFingerprint,
  findChildId,
  operatorToday,
  readDriveRootFolderId,
  readFinanceStateFromDrive,
  type DriveStateDeps,
  type FinanceState,
  type NotifyItem,
} from './finance.ts';
import { normalizeAmount } from './finance-intake.ts';
import {
  defaultGwsRunner,
  makeDriveDownloader,
  parseStateMd,
  resolveStateFile,
  type DriveDownloader,
  type GwsRunner,
  type LedgerDocument,
  type MonthState,
} from './state.ts';

/** Types whose unpaid invoices the operator must pay (and which carry into the actionable/notify set). */
const UNPAID_TYPES = new Set(['leverantörsfaktura', 'skattekonto']);
const ACTIONABLE_STATUSES = new Set(['unpaid', 'overdue']);

/** Parse a verbatim amount string to a number for the numeric anomaly rules. null if unparseable. */
function num(s: string): number | null {
  if (!s.trim()) return null;
  const n = Number(normalizeAmount(s));
  return Number.isFinite(n) ? n : null;
}

/**
 * Mark every unpaid leverantörsfaktura/skattekonto whose due date has passed as `overdue`. Pure —
 * returns the same object reference when nothing changed (so the caller can skip a needless state.md write).
 */
export function markOverdue(state: MonthState, today: string): MonthState {
  let changed = false;
  const documents = state.documents.map((d) => {
    if (UNPAID_TYPES.has(d.type) && d.paymentStatus === 'unpaid' && bucketFor(d.dueDate, today) === 'overdue') {
      changed = true;
      return { ...d, paymentStatus: 'overdue' };
    }
    return d;
  });
  return changed ? { ...state, documents } : state;
}

/** The PAY set for a period: every unpaid/overdue leverantörsfaktura + skattekonto. */
export function actionableDocs(state: MonthState): LedgerDocument[] {
  return state.documents.filter((d) => UNPAID_TYPES.has(d.type) && ACTIONABLE_STATUSES.has(d.paymentStatus));
}

/**
 * Recompute `notify.items` + the actionable-set fingerprint for a period from its current PAY set,
 * carrying forward the prior items' `acknowledged`/`last_notified` flags. This is the entrepreneur's
 * Step-4 threshold-crossing logic, made deterministic:
 *   - a docKey not seen before → added unacked.
 *   - a docKey still actionable → keep its ack/last_notified, refresh its bucket.
 *   - a docKey that crossed `due_soon → overdue` → re-fire (clear ack + last_notified) UNLESS it was
 *     acked AND the statement hasn't confirmed it yet (`export_status` pending/dropped/absent) — the
 *     bank-statement blind spot: trust the operator's "I paid it" until the statement arrives.
 *   - a docKey no longer actionable (paid/closed) → dropped (not carried over).
 * Fingerprint is computed by the SAME `finance.ts` function the gate uses, so the two never drift.
 */
export function updateNotify(
  prev: Record<string, NotifyItem>,
  actionable: LedgerDocument[],
  exportStatus: string | undefined,
  today: string,
): { items: Record<string, NotifyItem>; fingerprint: string | null } {
  const items: Record<string, NotifyItem> = {};
  const unconfirmed = exportStatus === undefined || exportStatus === 'pending' || exportStatus === 'dropped';
  for (const d of actionable) {
    const docKey = `${d.supplier}|${d.amount}|${d.dueDate}`;
    const bucket = bucketFor(d.dueDate, today);
    const existing = prev[docKey];
    let acknowledged = existing?.acknowledged ?? false;
    let lastNotified = existing?.last_notified ?? null;
    if (existing && bucket === 'overdue' && existing.bucket === 'due_soon' && !(acknowledged && unconfirmed)) {
      acknowledged = false; // the situation worsened and the payment isn't confirmed → re-surface it
      lastNotified = null;
    }
    items[docKey] = { bucket, acknowledged, last_notified: lastNotified, supplier: d.supplier, amount: d.amount, due_date: d.dueDate };
  }
  return { items, fingerprint: computeFingerprint(items, today) };
}

/** One anomaly flag against a specific document file. */
export interface AnomalyFlag {
  file: string;
  flag: string;
}

const VAT_RATES = [0, 0.06, 0.12, 0.25];

/**
 * The fixed anomaly rules, recomputed over a period's documents each run (idempotent: flags are
 * recomputed into the todo, never persisted). `priorSuppliers` is the set of suppliers seen in any
 * earlier month, for the "new supplier" rule. No judgment — every rule is a deterministic check.
 */
export function scanAnomalies(state: MonthState, priorSuppliers: Set<string>): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const occurrences = new Map<string, number>(); // supplier|amount → count, for the duplicate rule
  for (const d of state.documents) occurrences.set(`${d.supplier}|${d.amount}`, (occurrences.get(`${d.supplier}|${d.amount}`) ?? 0) + 1);

  for (const d of state.documents) {
    if (d.supplier && !priorSuppliers.has(d.supplier)) flags.push({ file: d.file, flag: '⚠ ny leverantör' });
    const amount = num(d.amount);
    if (amount !== null && amount > 10000) flags.push({ file: d.file, flag: `⚠ ${d.amount} > 10k` });
    if (d.type === 'leverantörsfaktura' && !d.ocrNumber && !d.bankAccount) flags.push({ file: d.file, flag: '⚠ saknar OCR/bankgiro' });
    const vat = num(d.vatAmount);
    if (amount !== null && vat !== null && vat > 0 && amount > vat) {
      const rate = vat / (amount - vat);
      if (!VAT_RATES.some((r) => Math.abs(rate - r) < 0.01)) flags.push({ file: d.file, flag: '⚠ avvikande moms' });
    }
    if (d.currency && d.currency !== 'SEK') flags.push({ file: d.file, flag: `⚠ valuta ${d.currency}` });
    if ((occurrences.get(`${d.supplier}|${d.amount}`) ?? 0) > 1) flags.push({ file: d.file, flag: '⚠ dubblett?' });
  }
  return flags;
}

// ---- todo + push composition (pure templating — todo is a record, not a pinned contract) -----------

type Urgency = 'URGENT' | 'SOON' | 'SCHEDULED';

/** URGENT = overdue or due ≤ 2 days; SOON = ≤ 7 days; else SCHEDULED. */
export function payUrgency(dueDate: string, today: string): Urgency {
  const b = bucketFor(dueDate, today);
  if (b === 'overdue') return 'URGENT';
  if (b === 'unparseable' || b === 'later') return 'SCHEDULED';
  // due_soon (≤7d): split off the most urgent 48h.
  const days = (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= 2 ? 'URGENT' : 'SOON';
}

const URGENCY_RANK: Record<Urgency, number> = { URGENT: 0, SOON: 1, SCHEDULED: 2 };

/** A period's rolled-up state, the shape both composers render and the orchestrator emits. */
export interface PeriodPlan {
  month: string;
  pay: LedgerDocument[];
  anomalies: AnomalyFlag[];
  exportNeeded: boolean;
  /** present when the month is closed (drafts await operator approval). */
  approve: { drafts: number } | null;
  /** a blocker line for a month that's over but not closed/reconciled. */
  waiting: string | null;
  storedFingerprint: string | null;
  freshFingerprint: string | null;
}

function payLine(d: LedgerDocument, today: string): string {
  const tag = payUrgency(d.dueDate, today);
  const ref = d.ocrNumber ? `OCR ${d.ocrNumber}` : d.bankAccount || '';
  return `- [${tag}] ${d.supplier} — ${d.amount} ${d.currency} — förfaller ${d.dueDate}${ref ? ` — ${ref}` : ''}`;
}

/** The full todo record, grouped by month (oldest first). Always written; not a notification. */
export function composeTodo(periods: PeriodPlan[], today: string): string {
  const blocks: string[] = [];
  for (const p of periods) {
    const lines = [`## Ekonomi ${p.month}`];
    const pay = [...p.pay].sort(
      (a, b) => URGENCY_RANK[payUrgency(a.dueDate, today)] - URGENCY_RANK[payUrgency(b.dueDate, today)] || a.dueDate.localeCompare(b.dueDate),
    );
    if (pay.length) lines.push('BETALA:', ...pay.map((d) => payLine(d, today)));
    if (p.exportNeeded) lines.push(`EXPORTERA: kontoutdrag för ${p.month} via BankID och maila till dig själv`);
    if (p.approve) {
      const flags = p.anomalies.map((a) => a.flag);
      lines.push(`GODKÄNN: ${p.approve.drafts} bokföringsutkast${flags.length ? ` (${[...new Set(flags)].join(', ')})` : ''}`);
    }
    if (p.waiting) lines.push(`VÄNTAR: ${p.waiting}`);
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }
  return blocks.length ? `# Att göra — ${today}\n\n${blocks.join('\n\n')}\n` : `# Att göra — ${today}\n\n(inget att göra)\n`;
}

/** The short Swedish WhatsApp push — emitted ONLY when a fingerprint changed. null when nothing to say. */
export function composePush(periods: PeriodPlan[], today: string): string | null {
  const changed = periods.filter((p) => p.freshFingerprint !== p.storedFingerprint);
  if (changed.length === 0) return null;
  const blocks: string[] = [];
  for (const p of changed) {
    const parts: string[] = [];
    const pay = [...p.pay].sort((a, b) => URGENCY_RANK[payUrgency(a.dueDate, today)] - URGENCY_RANK[payUrgency(b.dueDate, today)] || a.dueDate.localeCompare(b.dueDate));
    if (pay.length) {
      parts.push('BETALA: ' + pay.map((d) => {
        const u = payUrgency(d.dueDate, today);
        return `${d.supplier} ${d.amount} kr (förfaller ${d.dueDate}${u === 'URGENT' ? ', brådskande' : ''})`;
      }).join(' · '));
    }
    if (p.exportNeeded) parts.push('EXPORTERA: kontoutdrag via BankID');
    if (p.approve) parts.push(`GODKÄNN: ${p.approve.drafts} verifikat`);
    if (parts.length) blocks.push(`Ekonomi ${p.month}:\n${parts.join('\n')}`);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

// ---- read-only orchestrator (planFinanceRollup): reads Drive, computes, writes NOTHING -------------

export interface RollupDeps {
  run?: GwsRunner;
  download?: DriveDownloader;
  rootFolderId?: () => string | null;
  financeState?: DriveStateDeps;
  today?: string;
}

export interface RollupPlan {
  periods: PeriodPlan[];
  /** per-period notify.items the live run would persist (keyed by period). */
  notify: Record<string, { items: Record<string, NotifyItem>; fingerprint: string | null }>;
  todo: string;
  /** the operator push, or null when no fingerprint changed. */
  push: string | null;
  detail: string;
}

/** Step `delta` months from a YYYY-MM string (delta negative = earlier). */
function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Read + parse a month's state.md, or null when the month hasn't been started / can't be read. */
function readMonth(month: string, rootId: string, run: GwsRunner, download: DriveDownloader): MonthState | null {
  const monthId = findChildId(rootId, month, DRIVE_FOLDER_MIME, run);
  if (!monthId) return null;
  const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!doppId) return null;
  const ref = resolveStateFile(doppId, run);
  if (!ref) return null;
  const state = parseStateMd(download(ref.fileId));
  return state.month === '' ? null : state;
}

/**
 * Compute the heartbeat rollup for every open period WITHOUT writing anything — the read-only plan the
 * live run will later apply. Open periods = THIS_MONTH plus the two prior months whose state.md exists
 * and is still open (`Month-close sent: no`). Per period: mark overdue (in-memory), build the PAY set,
 * recompute notify.items + fingerprint (carrying acks from `state.json`), scan anomalies, and decide
 * export/approve/waiting. Then compose the todo + (changed-only) push. Best-effort: a Drive miss yields
 * an empty plan, never throws. This is what the shadow logs and what slice 3 will turn into writes.
 */
export function planFinanceRollup(deps: RollupDeps = {}): RollupPlan {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const today = deps.today ?? operatorToday();
  const thisMonth = today.slice(0, 7);
  const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
  const empty: RollupPlan = { periods: [], notify: {}, todo: composeTodo([], today), push: null, detail: 'no drive root folder id' };
  if (!rootId) return empty;

  const fs: FinanceState = readFinanceStateFromDrive(deps.financeState) ?? { version: 2, periods: {} };

  // Open periods: THIS_MONTH (always) + the two prior months that exist and aren't closed yet.
  const candidates = [addMonths(thisMonth, -2), addMonths(thisMonth, -1), thisMonth];
  const months: Array<{ month: string; state: MonthState }> = [];
  for (const m of candidates) {
    const state = readMonth(m, rootId, run, download);
    if (m === thisMonth) {
      if (state) months.push({ month: m, state }); // current month only contributes once started
    } else if (state && state.monthCloseSent !== 'yes') {
      months.push({ month: m, state });
    }
  }

  const periods: PeriodPlan[] = [];
  const notify: RollupPlan['notify'] = {};
  for (const { month, state } of months) {
    const dated = markOverdue(state, today);
    const pay = actionableDocs(dated);
    const periodMeta = fs.periods?.[month] ?? {};
    const exportStatus = periodMeta.export_status;
    const { items, fingerprint } = updateNotify(periodMeta.notify?.items ?? {}, pay, exportStatus, today);
    const priorSuppliers = new Set(months.filter((x) => x.month < month).flatMap((x) => x.state.documents.map((d) => d.supplier)));
    const anomalies = scanAnomalies(dated, priorSuppliers);
    const over = thisMonth > month;
    periods.push({
      month,
      pay,
      anomalies,
      exportNeeded: over && exportStatus !== 'reconciled',
      approve: dated.monthCloseSent === 'yes' ? { drafts: dated.documents.filter((d) => d.fortnoxSent === 'yes').length } : null,
      waiting: over && dated.monthCloseSent !== 'yes' && exportStatus !== 'reconciled' ? `${month}: väntar på kontoutdrag` : null,
      storedFingerprint: periodMeta.notify?.fingerprint ?? null,
      freshFingerprint: fingerprint,
    });
    notify[month] = { items, fingerprint };
  }

  return {
    periods,
    notify,
    todo: composeTodo(periods, today),
    push: composePush(periods, today),
    detail: `${periods.length} open period(s)`,
  };
}
