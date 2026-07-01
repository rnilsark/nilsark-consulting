// The `digest` orchestrator, in TypeScript — the finance heartbeat's JUDGMENT-LESS rollup, plus the
// skip-gate that decides whether a heartbeat needs to run at all. None of it is judgment: marking
// overdue is a date compare, the actionable set is a filter, the notify-items + fingerprint are a
// pinned contract (`ledger-store.ts` recomputes the fingerprint byte-for-byte), and the anomaly flags
// are fixed rules. So it's deterministic, unit-tested code the `digest` worker runs instead of paying
// for an LLM. Pure functions over the parsed `MonthState` + `state.json`; Drive I/O is the worker's
// job (kept out of the pure parts so they stay trivially testable).

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { insertOutbox, insertQueue, lastDigestRunSuccess, operatorPushTarget, type Db } from '../db.ts';
import {
  DIGEST_RUN_TASK,
  DRIVE_FOLDER_MIME,
  bucketFor,
  computeFingerprint,
  findChildId,
  operatorToday,
  readDriveRootFolderId,
  readLedgerSettings,
  readLedgerState,
  writeLedgerState,
  type LedgerStoreDeps,
  type LedgerSettings,
  type LedgerState,
  type NotifyItem,
} from './ledger-store.ts';
import { normalizeAmount } from './intake.ts';
import { runMonthClose } from './month-close.ts';
import {
  defaultGwsRunner,
  makeDriveDownloader,
  parseStateMd,
  resolveStateFile,
  writeMonthState,
  type DriveDownloader,
  type GwsRunner,
  type LedgerDocument,
  type MonthState,
  type StateFileRef,
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
 * Reconcile the `overdue` flag with the current due date, both ways: an unpaid leverantörsfaktura/
 * skattekonto whose due date has passed becomes `overdue`, and an `overdue` one whose due date is no
 * longer in the past reverts to `unpaid` (e.g. after a due-date correction — a stale overdue must clear,
 * or it keeps nagging with the wrong urgency). Never touches `paid`. Pure — returns the same object
 * reference when nothing changed (so the caller can skip a needless state.md write).
 */
export function markOverdue(state: MonthState, today: string): MonthState {
  let changed = false;
  const documents = state.documents.map((d) => {
    if (!UNPAID_TYPES.has(d.type)) return d;
    const overdue = bucketFor(d.dueDate, today) === 'overdue';
    if (d.paymentStatus === 'unpaid' && overdue) { changed = true; return { ...d, paymentStatus: 'overdue' }; }
    if (d.paymentStatus === 'overdue' && !overdue) { changed = true; return { ...d, paymentStatus: 'unpaid' }; }
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
 * Fingerprint is computed by the SAME `ledger-store.ts` function the gate uses, so the two never drift.
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

// ---- read-only orchestrator (planDigest): reads Drive, computes, writes NOTHING -------------

export interface DigestDeps {
  run?: GwsRunner;
  download?: DriveDownloader;
  rootFolderId?: () => string | null;
  financeState?: LedgerStoreDeps;
  today?: string;
}

export interface DigestPlan {
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

/** A gathered open period: the parsed ledger + the Drive refs needed to write it back. */
interface GatheredPeriod {
  month: string;
  doppId: string;
  ref: StateFileRef;
  dated: MonthState; // after markOverdue
  overdueChanged: boolean;
  exportStatus: string | undefined;
  plan: PeriodPlan;
  items: Record<string, NotifyItem>;
  fingerprint: string | null;
}

interface Gathered {
  rootId: string;
  fs: LedgerState;
  today: string;
  thisMonth: string;
  periods: GatheredPeriod[];
}

/** Read + parse a month's state.md, keeping the Drive refs so the caller can write it back. */
function readMonthRef(
  month: string,
  rootId: string,
  run: GwsRunner,
  download: DriveDownloader,
): { doppId: string; ref: StateFileRef; state: MonthState } | null {
  const monthId = findChildId(rootId, month, DRIVE_FOLDER_MIME, run);
  if (!monthId) return null;
  const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!doppId) return null;
  const ref = resolveStateFile(doppId, run);
  if (!ref) return null;
  const state = parseStateMd(download(ref.fileId));
  return state.month === '' ? null : { doppId, ref, state };
}

/**
 * The shared read+compute both `planDigest` (read-only) and `runDigest` (read-write)
 * build on, so the plan and the writes can never diverge. Open periods = THIS_MONTH plus the two prior
 * months whose state.md exists and is still open (`Month-close sent: no`). Per period: mark overdue
 * (in-memory), build the PAY set, recompute notify.items + fingerprint (carrying acks from state.json),
 * scan anomalies, decide export/approve/waiting. Returns null when there's no Drive root.
 */
function gatherDigest(deps: DigestDeps): Gathered | null {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const today = deps.today ?? operatorToday();
  const thisMonth = today.slice(0, 7);
  const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return null;

  const fs: LedgerState = readLedgerState(deps.financeState) ?? { version: 2, periods: {} };

  const candidates = [addMonths(thisMonth, -2), addMonths(thisMonth, -1), thisMonth];
  const read: Array<{ month: string; doppId: string; ref: StateFileRef; state: MonthState }> = [];
  for (const m of candidates) {
    const r = readMonthRef(m, rootId, run, download);
    if (!r) continue;
    if (m === thisMonth || r.state.monthCloseSent !== 'yes') read.push({ month: m, ...r }); // current always; priors only while open
  }

  const periods: GatheredPeriod[] = read.map(({ month, doppId, ref, state }) => {
    const dated = markOverdue(state, today);
    const pay = actionableDocs(dated);
    const periodMeta = fs.periods?.[month] ?? {};
    const exportStatus = periodMeta.export_status;
    const { items, fingerprint } = updateNotify(periodMeta.notify?.items ?? {}, pay, exportStatus, today);
    const priorSuppliers = new Set(read.filter((x) => x.month < month).flatMap((x) => x.state.documents.map((d) => d.supplier)));
    const anomalies = scanAnomalies(dated, priorSuppliers);
    const over = thisMonth > month;
    return {
      month, doppId, ref, dated, exportStatus, items, fingerprint,
      overdueChanged: dated !== state,
      plan: {
        month, pay, anomalies,
        exportNeeded: over && exportStatus !== 'reconciled',
        approve: dated.monthCloseSent === 'yes' ? { drafts: dated.documents.filter((d) => d.fortnoxSent === 'yes').length } : null,
        waiting: over && dated.monthCloseSent !== 'yes' && exportStatus !== 'reconciled' ? `${month}: väntar på kontoutdrag` : null,
        storedFingerprint: periodMeta.notify?.fingerprint ?? null,
        freshFingerprint: fingerprint,
      },
    };
  });
  return { rootId, fs, today, thisMonth, periods };
}

/** Read-only rollup: the plan the live run will apply. Writes NOTHING — the shadow logs this. */
export function planDigest(deps: DigestDeps = {}): DigestPlan {
  const today = deps.today ?? operatorToday();
  const g = gatherDigest(deps);
  if (!g) return { periods: [], notify: {}, todo: composeTodo([], today), push: null, detail: 'no drive root folder id' };
  const periods = g.periods.map((p) => p.plan);
  const notify: DigestPlan['notify'] = {};
  for (const p of g.periods) notify[p.month] = { items: p.items, fingerprint: p.fingerprint };
  return { periods, notify, todo: composeTodo(periods, g.today), push: composePush(periods, g.today), detail: `${periods.length} open period(s)` };
}

/** Upload the todo record to `<DRIVE_ROOT>/.doppelganger/todo-<today>.md` (overwrites the day's file). */
function uploadTodo(rootId: string, today: string, content: string, run: GwsRunner): boolean {
  const doppId = findChildId(rootId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!doppId) return false;
  const name = `todo-${today}.md`;
  const existing = findChildId(doppId, name, null, run);
  const dir = mkdtempSync(path.join(tmpdir(), 'dg-todo-'));
  try {
    writeFileSync(path.join(dir, name), content);
    const res = existing
      ? run(['drive', 'files', 'update', '--params', JSON.stringify({ fileId: existing }), '--upload', name, '--upload-content-type', 'text/markdown'], { cwd: dir })
      : run(['drive', '+upload', name, '--parent', doppId, '--name', name, '--format', 'json'], { cwd: dir });
    return res.ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ApplyResult {
  periods: number;
  pushed: boolean;
  closed: string | null;
  detail: string;
}

/**
 * The live heartbeat run (what the `digest` worker executes): gather the rollup, then WRITE —
 * persist each period's overdue marks to state.md, write notify.items + fingerprint to state.json,
 * upload the todo, push the operator (only when a fingerprint changed), and close the first ready prior
 * month as drafts. Each write is independent + best-effort; a single Drive miss degrades that step, not
 * the whole run. This is the dissolved entrepreneur run, deterministic and LLM-free.
 */
export function runDigest(db: Db, deps: DigestDeps & { settings?: LedgerSettings } = {}): ApplyResult {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const g = gatherDigest(deps);
  if (!g) return { periods: 0, pushed: false, closed: null, detail: 'no drive root folder id' };

  // 1. overdue marks → state.md (only the periods that actually changed).
  for (const p of g.periods) {
    if (p.overdueChanged) {
      const w = writeMonthState(p.dated, p.doppId, p.ref, run);
      if (!w.ok) console.error(`[finance] state.md write for ${p.month} failed: ${w.reason}`);
    }
  }

  // 2. notify.items + fingerprint → state.json (merge over the existing periods, refresh last_run).
  const periodsOut: Record<string, { export_status?: string; notify: { fingerprint: string | null; items: Record<string, NotifyItem> } }> = {};
  for (const [m, meta] of Object.entries(g.fs.periods ?? {})) periodsOut[m] = { export_status: meta.export_status, notify: { fingerprint: meta.notify?.fingerprint ?? null, items: meta.notify?.items ?? {} } };
  for (const p of g.periods) periodsOut[p.month] = { export_status: p.exportStatus, notify: { fingerprint: p.fingerprint, items: p.items } };
  const lastRun = { ...((g.fs.last_run as Record<string, unknown>) ?? {}), cadence: new Date().toISOString() };
  const wj = writeLedgerState({ version: 2, last_run: lastRun, periods: periodsOut }, deps.financeState);
  if (!wj.ok) console.error(`[finance] state.json write failed: ${wj.detail}`);

  // 3. todo record + 4. operator push (changed-only).
  const plans = g.periods.map((p) => p.plan);
  uploadTodo(g.rootId, g.today, composeTodo(plans, g.today), run);
  const push = composePush(plans, g.today);
  let pushed = false;
  if (push && config.operatorNumber) {
    const target = operatorPushTarget(db, config.operatorNumber);
    if (target) { insertOutbox(db, { channel: target.channel, conversation_id: target.conversationId, text: push }); pushed = true; }
  }

  // 5. close the FIRST ready prior month (over + reconciled + not closed) — at most one per run.
  let closed: string | null = null;
  const ready = g.periods.find((p) => g.thisMonth > p.month && p.exportStatus === 'reconciled' && p.dated.monthCloseSent !== 'yes');
  if (ready) {
    const r = runMonthClose(ready.month, { run, download, rootFolderId: () => g.rootId, settings: deps.settings });
    if (r.closed) closed = ready.month;
    console.log(`[finance] month-close ${ready.month}: ${r.detail}`);
  }

  return { periods: g.periods.length, pushed, closed, detail: `${g.periods.length} period(s)${pushed ? ', pushed' : ''}${closed ? `, closed ${closed}` : ''}` };
}

/**
 * The chat ack fast-path (the entrepreneur's old ack loop, in TS): the operator said they paid a
 * supplier, so mark every matching `notify.items` entry `acknowledged: true` (suppressing it from
 * pushes) and recompute that period's fingerprint so the gate goes quiet. Match is a case-insensitive
 * substring of the docKey (which embeds the supplier). No Gmail, no Drive document I/O — just state.json.
 * The bank statement still wins later: a reconcile that doesn't confirm the payment re-surfaces it.
 */
export function ackPayment(supplier: string, deps: { financeState?: LedgerStoreDeps; today?: string } = {}): { matched: number } {
  const needle = supplier.trim().toLowerCase();
  if (!needle) return { matched: 0 };
  const fs = readLedgerState(deps.financeState);
  if (!fs) return { matched: 0 };
  const today = deps.today ?? operatorToday();
  const periodsOut = { ...(fs.periods ?? {}) };
  let matched = 0;
  for (const [month, meta] of Object.entries(periodsOut)) {
    const items = { ...(meta.notify?.items ?? {}) };
    let changed = false;
    for (const [key, it] of Object.entries(items)) {
      if (key.toLowerCase().includes(needle) && it.acknowledged !== true) {
        items[key] = { ...it, acknowledged: true };
        matched++;
        changed = true;
      }
    }
    if (changed) periodsOut[month] = { ...meta, notify: { fingerprint: computeFingerprint(items, today), items } };
  }
  if (matched > 0) writeLedgerState({ version: 2, last_run: fs.last_run, periods: periodsOut }, deps.financeState);
  return { matched };
}

// ---- the heartbeat gate: decide whether to enqueue a `digest` run ------------
// The scheduler asks this once a day. It's the digest's own trigger, so it lives with the digest (not
// the ledger store it reads): decide → audit → enqueue. Conservative — every uncertain branch fires.

/** Append-only audit trail of gate decisions, so "what did TS skip" is reviewable. */
const DIGEST_GATE_LOG_PATH = path.join(config.home, 'finance-gate.jsonl');

export type GateAction = 'fire' | 'skip';

export interface GateDecision {
  action: GateAction;
  reason: string;
}

export interface GateLogEntry extends GateDecision {
  ts: string;
}

/**
 * The pure decision: given the current state, the age of the last successful run, and today, should
 * the daily heartbeat fire or skip? Conservative — every uncertain branch returns `fire`.
 */
export function decideGate(
  state: LedgerState | null,
  lastSuccessAgeMs: number | null,
  today: string,
  backstopMaxAgeMs: number,
): GateDecision {
  // Backstop: if no successful run has landed within the window (or ever), fire unconditionally.
  // This is the periodic full sweep that keeps anything wrongly skipped surfacing within days.
  if (lastSuccessAgeMs === null) return { action: 'fire', reason: 'backstop: no successful run on record' };
  if (lastSuccessAgeMs >= backstopMaxAgeMs) {
    return { action: 'fire', reason: `backstop: last success ${Math.round(lastSuccessAgeMs / 3_600_000)}h ago` };
  }

  if (state === null) return { action: 'fire', reason: 'state.json missing or unreadable' };
  if (state.version !== 2) return { action: 'fire', reason: `state.json version ${String(state.version)} ≠ 2` };

  const periods = state.periods ?? {};
  for (const [period, p] of Object.entries(periods)) {
    const notify = p.notify ?? {};
    const stored = notify.fingerprint ?? null;
    if (stored === null) return { action: 'fire', reason: `period ${period}: no stored fingerprint` };
    const fresh = computeFingerprint(notify.items ?? {}, today);
    if (fresh === null) return { action: 'fire', reason: `period ${period}: actionable set unprovable (missing/!ISO due_date)` };
    if (fresh !== stored) {
      return { action: 'fire', reason: `period ${period}: fingerprint changed (${stored} → ${fresh})` };
    }
  }
  return { action: 'skip', reason: 'no actionable change in any open period' };
}

/**
 * The last gate decision that was a `skip`, from the audit log — newest first. The healthcheck treats
 * a recent deliberate skip (nothing actionable) as a healthy heartbeat, not a stalled agent.
 */
export function lastDigestGateSkip(logPath: string = DIGEST_GATE_LOG_PATH): GateLogEntry | null {
  let content: string;
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as GateLogEntry;
      if (entry.action === 'skip') return entry;
    } catch {
      // ignore a malformed line and keep scanning back
    }
  }
  return null;
}

/** Append one decision to the audit log. Best-effort — a logging failure never blocks the gate. */
export function logGateDecision(entry: GateLogEntry, logPath: string = DIGEST_GATE_LOG_PATH): void {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(`[digest-gate] failed to append audit log: ${(err as Error).message}`);
  }
}

/** Is a heartbeat `run` already pending or running? Avoids piling heartbeats on a slow/queued run. */
function heartbeatAlreadyQueued(db: Db): boolean {
  const row = db
    .prepare(`SELECT 1 FROM queue WHERE agent = 'digest' AND task = ? LIMIT 1`)
    .get(DIGEST_RUN_TASK);
  return row !== undefined;
}

export interface GateDeps {
  readState: () => LedgerState | null;
  now: () => Date;
  log: (entry: GateLogEntry) => void;
}

const defaultGateDeps: GateDeps = {
  readState: () => readLedgerState(),
  now: () => new Date(),
  log: (entry) => logGateDecision(entry),
};

/**
 * The whole verdict, including the parts that need the DB/clock (dedup guard, last-success age); the
 * pure core stays in `decideGate`. One place produces the decision, so the caller is a flat
 * decide → log → act.
 */
function gateDecision(db: Db, state: LedgerState | null, at: Date): GateDecision {
  if (heartbeatAlreadyQueued(db)) {
    return { action: 'skip', reason: 'heartbeat run already pending/running' };
  }
  const last = lastDigestRunSuccess(db);
  const lastSuccessAgeMs = last ? Math.max(0, at.getTime() - Date.parse(last.ts)) : null;
  const backstopMaxAgeMs = config.financeBackstopMaxAgeHours * 3_600_000;
  return decideGate(state, lastSuccessAgeMs, operatorToday(at), backstopMaxAgeMs);
}

/**
 * The gated heartbeat: decide, audit, and enqueue a `digest` run only when work is (or might be) due.
 * Wired to the heartbeat cron in place of an unconditional enqueue. Returns the decision (handy for
 * tests/logs).
 */
export function maybeEnqueueDigest(db: Db, deps: GateDeps = defaultGateDeps): GateDecision {
  const at = deps.now();
  const decision = gateDecision(db, deps.readState(), at);

  deps.log({ ...decision, ts: at.toISOString() });
  if (decision.action === 'fire') {
    insertQueue(db, { agent: 'digest', task: DIGEST_RUN_TASK, parent: null });
  }
  console.log(`[digest-gate] ${decision.action} (${decision.reason})`);
  return decision;
}
