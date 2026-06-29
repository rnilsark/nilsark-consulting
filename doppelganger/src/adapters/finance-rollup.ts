// The finance heartbeat's JUDGMENT-LESS rollup, in TypeScript — the work the `entrepreneur` LLM run
// used to do once collection was peeled off it. None of it is judgment: marking overdue is a date
// compare, the actionable set is a filter, the notify-items + fingerprint are a pinned contract
// (`finance.ts` already recomputes the fingerprint byte-for-byte), and the anomaly flags are fixed
// rules. So it lives here as deterministic, unit-tested code, and the `finance` orchestrator-star runs
// it instead of paying for an LLM. Pure functions over the parsed `MonthState` + `state.json`; Drive
// I/O is the orchestrator's job (kept out of here so this stays trivially testable).

import { bucketFor, computeFingerprint, type NotifyItem } from './finance.ts';
import { normalizeAmount } from './finance-intake.ts';
import type { LedgerDocument, MonthState } from './state.ts';

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
