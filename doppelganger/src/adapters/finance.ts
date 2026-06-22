import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { insertQueue, lastEntrepreneurSuccess, type Db } from '../db.ts';

// The finance orchestrator-star (deterministic, no LLM). It decides whether the daily
// `entrepreneur/run` heartbeat needs to fire at all — the skip-gate from the star-clusters plan,
// step 1. The god-object's "re-derive everything every run" was its own safety net; removing it
// risks a silently dropped invoice (= a missing verification, with tax consequences), so this gate
// is built CONSERVATIVE BY CONSTRUCTION: it skips only when it can PROVE nothing actionable changed,
// fires the LLM on ANY ambiguity, logs every decision for audit, and is backstopped by an
// unconditional fire whenever no successful run has landed within the backstop window.

/** The entrepreneur's heartbeat task — the plain string the schedule enqueues. */
export const ENTREPRENEUR_RUN_TASK = 'run';

/**
 * Local mirror of the entrepreneur's run-metadata state. The daemon and the agent share this box.
 * It lives under `agents/<agent>/` because the worker runs each agent with that as its cwd
 * (`worker.ts`: `cwd = agentsDir/<agent>`), and the entrepreneur writes `staging/.state/` relative to
 * there. Must stay in lockstep with the agent's actual write location — a mismatch makes the gate read
 * nothing and fire every time (safe, but a silent no-op).
 */
export const FINANCE_STATE_PATH = path.join(
  config.agentSettingsDir,
  'entrepreneur',
  'staging',
  '.state',
  'state.json',
);

/** Append-only audit trail of gate decisions, so "what did TS skip" is reviewable (review #4). */
export const FINANCE_GATE_LOG_PATH = path.join(config.home, 'finance-gate.jsonl');

/**
 * One actionable item, as the entrepreneur projects it into `state.json` `notify.items` (keyed by
 * docKey). `due_date` / `supplier` / `amount` are the ADDITIVE fields the gate needs to recompute
 * the fingerprint without parsing `state.md`; absent on pre-migration data → the gate cannot prove
 * the set and fires (self-healing).
 */
export interface NotifyItem {
  bucket?: string;
  acknowledged?: boolean;
  last_notified?: string | null;
  supplier?: string;
  amount?: string | number;
  due_date?: string;
}

export interface NotifyState {
  fingerprint?: string | null;
  items?: Record<string, NotifyItem>;
}

export interface PeriodState {
  export_status?: string;
  notify?: NotifyState;
}

export interface FinanceState {
  version?: number;
  last_run?: unknown;
  periods?: Record<string, PeriodState>;
}

export type GateAction = 'fire' | 'skip';

export interface GateDecision {
  action: GateAction;
  reason: string;
}

export interface GateLogEntry extends GateDecision {
  ts: string;
}

/** Today's date as a YYYY-MM-DD string in the operator's timezone (matches the agent's `date +%F`). */
export function operatorToday(at: Date = new Date()): string {
  // sv-SE formats as YYYY-MM-DD; Europe/Stockholm matches what the agent's `date` sees on the box.
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(at);
}

/** Parse a YYYY-MM-DD string to a UTC ms-epoch at midnight. NaN if it isn't a real ISO date. */
function isoDayMs(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * The bucket an unpaid item falls in, recomputed from its due date vs today — the same two buckets
 * the entrepreneur uses. `overdue` (past due) | `due_soon` (≤7 days out). Items due further out are
 * not in the fingerprint (you don't nag three weeks early); they enter when they cross into due_soon.
 * Returns `'unparseable'` when the due date isn't a real ISO day → the caller treats that as "can't
 * prove the set → fire".
 */
export function bucketFor(dueDate: string, today: string): 'overdue' | 'due_soon' | 'later' | 'unparseable' {
  const due = isoDayMs(dueDate);
  const t = isoDayMs(today);
  if (!Number.isFinite(due) || !Number.isFinite(t)) return 'unparseable';
  if (t > due) return 'overdue';
  const days = (due - t) / 86_400_000;
  return days <= 7 ? 'due_soon' : 'later';
}

/**
 * Recompute the actionable-set fingerprint from `notify.items`, EXACTLY as the entrepreneur does, so
 * the gate can predict "would the run push?". Pinned contract (must stay byte-identical on both sides):
 *   - actionable = items with `acknowledged !== true` whose recomputed bucket is `overdue`/`due_soon`
 *   - sort by (due_date asc, supplier asc)
 *   - per-item token = `${docKey}|${bucket}` (docKey already embeds `supplier|amount|due_date`, so the
 *     amount is taken verbatim — TS never reformats it, which is what avoids float-format drift)
 *   - canonical = tokens joined by "\n"; fingerprint = sha256(canonical), first 16 hex chars
 * Returns `null` when the set can't be proven (any actionable item missing/!ISO due_date) → fire.
 */
export function computeFingerprint(
  items: Record<string, NotifyItem>,
  today: string,
): string | null {
  const tokens: Array<{ docKey: string; supplier: string; due_date: string; bucket: string }> = [];
  for (const [docKey, item] of Object.entries(items)) {
    if (item.acknowledged === true) continue;
    if (typeof item.due_date !== 'string') return null; // pre-migration / missing → can't prove
    const bucket = bucketFor(item.due_date, today);
    if (bucket === 'unparseable') return null;
    if (bucket === 'later') continue; // not actionable yet → excluded from the fingerprint
    tokens.push({ docKey, supplier: item.supplier ?? '', due_date: item.due_date, bucket });
  }
  tokens.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.supplier.localeCompare(b.supplier));
  const canonical = tokens.map((t) => `${t.docKey}|${t.bucket}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * The pure decision: given the current state, the age of the last successful run, and today, should
 * the daily heartbeat fire the LLM or skip? Conservative — every uncertain branch returns `fire`.
 */
export function decideGate(
  state: FinanceState | null,
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

/** Read + parse the local state.json. Any failure → null (the gate reads null as "fire"). */
export function readFinanceState(statePath: string = FINANCE_STATE_PATH): FinanceState | null {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as FinanceState;
  } catch {
    return null;
  }
}

/** Append one decision to the audit log. Best-effort — a logging failure never blocks the gate. */
export function logGateDecision(entry: GateLogEntry, logPath: string = FINANCE_GATE_LOG_PATH): void {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(`[finance-gate] failed to append audit log: ${(err as Error).message}`);
  }
}

/** Is a heartbeat `run` already pending or running? Avoids piling heartbeats on a slow/queued run. */
function heartbeatAlreadyQueued(db: Db): boolean {
  const row = db
    .prepare(`SELECT 1 FROM queue WHERE agent = 'entrepreneur' AND task = ? LIMIT 1`)
    .get(ENTREPRENEUR_RUN_TASK);
  return row !== undefined;
}

export interface GateDeps {
  readState: () => FinanceState | null;
  now: () => Date;
  log: (entry: GateLogEntry) => void;
}

const defaultDeps: GateDeps = {
  readState: () => readFinanceState(),
  now: () => new Date(),
  log: (entry) => logGateDecision(entry),
};

/**
 * The whole verdict, including the parts that need the DB/clock (dedup guard, last-success age); the
 * pure core stays in `decideGate`. One place produces the decision, so the caller is a flat
 * decide → log → act.
 */
function gateDecision(db: Db, state: FinanceState | null, at: Date): GateDecision {
  if (heartbeatAlreadyQueued(db)) {
    return { action: 'skip', reason: 'heartbeat run already pending/running' };
  }
  const last = lastEntrepreneurSuccess(db);
  const lastSuccessAgeMs = last ? Math.max(0, at.getTime() - Date.parse(last.ts)) : null;
  const backstopMaxAgeMs = config.financeBackstopMaxAgeHours * 3_600_000;
  return decideGate(state, lastSuccessAgeMs, operatorToday(at), backstopMaxAgeMs);
}

/**
 * The gated heartbeat: decide, audit, and enqueue `entrepreneur/run` only when work is (or might be)
 * due. Wired to the finance heartbeat cron in place of the old unconditional enqueue. Returns the
 * decision (handy for tests/logs).
 */
export function maybeEnqueueFinanceRun(db: Db, deps: GateDeps = defaultDeps): GateDecision {
  const at = deps.now();
  const decision = gateDecision(db, deps.readState(), at);

  deps.log({ ...decision, ts: at.toISOString() });
  if (decision.action === 'fire') {
    insertQueue(db, { agent: 'entrepreneur', task: ENTREPRENEUR_RUN_TASK, parent: null });
  }
  console.log(`[finance-gate] ${decision.action} (${decision.reason})`);
  return decision;
}
