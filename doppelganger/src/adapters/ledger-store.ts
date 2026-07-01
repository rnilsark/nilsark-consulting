import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { insertQueue, lastDigestRunSuccess, type Db } from '../db.ts';
import {
  defaultGwsRunner,
  makeDriveDownloader,
  parseStateMd,
  renderStateMd,
  resolveStateFile,
  type DriveDownloader,
  type GwsRunner,
  type LedgerDocument,
} from './state.ts';

// The ledger store: the AUTHORITATIVE run-metadata `state.json` on Drive (read/write), plus the shared
// Drive/date/fingerprint helpers the finance pipeline builds on. Deterministic, no LLM. The `digest`
// heartbeat and its skip-gate live in `digest.ts`; this module is only the state + plumbing they read.

/** The heartbeat task — the plain string the gate enqueues for the `digest` orchestrator. */
export const DIGEST_RUN_TASK = 'run';

/**
 * The finance settings file (Drive root folder id, draft recipients, draftTestMode). Kept under the
 * legacy `entrepreneur/` settings dir — the file the box already has — so the rename didn't require
 * migrating prod state. It's just where the JSON lives; nothing LLM reads it anymore.
 */
export const LEDGER_SETTINGS_PATH = path.join(
  config.agentSettingsDir,
  'entrepreneur',
  'settings.json',
);

/** The finance settings the TS orchestrators read (root folder id + month-close draft routing). */
export interface LedgerSettings {
  driveRootFolderId?: string;
  myEmail?: string;
  fortnoxEmail?: Record<string, string>;
  draftTestMode?: boolean;
}

/** Read the whole settings.json, or `{}` if absent/unreadable. */
export function readLedgerSettings(settingsPath: string = LEDGER_SETTINGS_PATH): LedgerSettings {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as LedgerSettings;
  } catch {
    return {};
  }
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

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

export interface LedgerState {
  version?: number;
  last_run?: unknown;
  periods?: Record<string, PeriodState>;
}

/** Today's date as a YYYY-MM-DD string in the operator's timezone (matches the agent's `date +%F`). */
export function operatorToday(at: Date = new Date()): string {
  // sv-SE formats as YYYY-MM-DD; Europe/Stockholm matches what the agent's `date` sees on the box.
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(at);
}

/** The month before `today` (YYYY-MM) — what a bank statement reconciles, and what the nudge asks for. */
export function prevMonth(today: string = operatorToday()): string {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1)); // m-1 = current month index; m-2 = previous
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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

/** The entrepreneur's Drive root folder id, from its settings.json. null if unreadable → gate fires. */
export function readDriveRootFolderId(settingsPath: string = LEDGER_SETTINGS_PATH): string | null {
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as { driveRootFolderId?: string };
    return typeof s.driveRootFolderId === 'string' && s.driveRootFolderId ? s.driveRootFolderId : null;
  } catch {
    return null;
  }
}

/** Resolve a single child id by name (+ optional mimeType) under a Drive folder. null on any miss. */
export function findChildId(parentId: string, name: string, mimeType: string | null, run: GwsRunner): string | null {
  const clauses = [`name='${name}'`, `'${parentId}' in parents`, 'trashed=false'];
  if (mimeType) clauses.push(`mimeType='${mimeType}'`);
  // orderBy makes resolution deterministic: if a duplicate name ever exists (a create race that
  // slipped past a list-before-create), always resolve to the same one so filing never splits.
  const params = JSON.stringify({ q: clauses.join(' and '), fields: 'files(id)', orderBy: 'createdTime' });
  const res = run(['drive', 'files', 'list', '--params', params, '--format', 'json']);
  if (!res.ok) return null;
  try {
    return (JSON.parse(res.stdout) as { files?: Array<{ id?: string }> }).files?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a child folder by name, creating it if absent. Returns null only when a needed create
 * fails. This is what lets the filing path scaffold a fresh month on demand instead of hard-failing
 * on the 1st (the TS heartbeat otherwise never creates folders). findChildId orders by createdTime,
 * so if a concurrent create ever races us the resolution stays deterministic (worst case: one empty
 * duplicate folder, never a split).
 */
export function ensureChildFolder(parentId: string, name: string, run: GwsRunner): string | null {
  const existing = findChildId(parentId, name, DRIVE_FOLDER_MIME, run);
  if (existing) return existing;
  const res = run([
    'drive', 'files', 'create', '--json',
    JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] }),
    '--format', 'json',
  ]);
  if (!res.ok) return null;
  try {
    return (JSON.parse(res.stdout) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

export interface LedgerStoreDeps {
  run?: GwsRunner;
  download?: DriveDownloader;
  rootFolderId?: () => string | null;
}

/**
 * Read the entrepreneur's AUTHORITATIVE run-metadata state.json from the Drive mirror
 * (`<DRIVE_ROOT>/.doppelganger/state.json`). The local cache the agent keeps is not reliably current —
 * the agent treats Drive as the source of truth — so the gate must read Drive to decide correctly.
 * EVERY failure (no root id, folder/file not found, gws error, bad JSON, download throw) returns null,
 * which the gate reads as "can't prove the set → fire". Conservative by construction.
 */
export function readLedgerState(deps: LedgerStoreDeps = {}): LedgerState | null {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return null;
  const folderId = findChildId(rootId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!folderId) return null;
  const fileId = findChildId(folderId, 'state.json', null, run);
  if (!fileId) return null;
  try {
    return JSON.parse(download(fileId)) as LedgerState;
  } catch {
    return null;
  }
}

const UNPAID_STATUSES = new Set(['unpaid', 'overdue']);

/**
 * Project a freshly-filed unpaid invoice into the gate's `state.json` `notify.items`, keyed by the
 * pinned docKey `supplier|amount|due_date`. The fingerprint is DELIBERATELY left stale — that
 * staleness is exactly the signal the daily gate fires on (so the operator hears about a new invoice).
 * Non-unpaid / no-due-date / unparseable-date docs are not actionable → state returned unchanged.
 * Pure: the input is not mutated. Forces `version: 2` so the gate trusts it.
 */
export function projectNotifyItem(
  state: LedgerState,
  period: string,
  doc: LedgerDocument,
  today: string,
): LedgerState {
  if (!UNPAID_STATUSES.has(doc.paymentStatus) || !doc.dueDate) return state;
  const bucket = bucketFor(doc.dueDate, today);
  if (bucket === 'unparseable') return state;

  const periods = { ...(state.periods ?? {}) };
  const p = { ...(periods[period] ?? { export_status: 'pending' }) };
  const notify = { ...(p.notify ?? { fingerprint: null, items: {} }) };
  const items = { ...(notify.items ?? {}) };
  items[`${doc.supplier}|${doc.amount}|${doc.dueDate}`] = {
    bucket,
    acknowledged: false,
    last_notified: null,
    supplier: doc.supplier,
    amount: doc.amount,
    due_date: doc.dueDate,
  };
  p.notify = { fingerprint: notify.fingerprint ?? null, items }; // fingerprint left stale ON PURPOSE
  periods[period] = p;
  return { version: 2, last_run: state.last_run, periods };
}

/**
 * After a reconcile: mark the period `reconciled` and drop the now-paid invoices from `notify.items`
 * (paid → no longer actionable). Fingerprint left stale so the gate re-derives. Pure; forces v2.
 */
export function markReconciled(
  state: LedgerState,
  period: string,
  paid: Array<{ supplier: string; amount: string; dueDate: string }>,
): LedgerState {
  const periods = { ...(state.periods ?? {}) };
  const p = { ...(periods[period] ?? {}) };
  p.export_status = 'reconciled';
  const notify = { ...(p.notify ?? { fingerprint: null, items: {} }) };
  const items = { ...(notify.items ?? {}) };
  for (const d of paid) delete items[`${d.supplier}|${d.amount}|${d.dueDate}`];
  p.notify = { fingerprint: notify.fingerprint ?? null, items };
  periods[period] = p;
  return { version: 2, last_run: state.last_run, periods };
}

/** Write the run-metadata `state.json` back to the Drive mirror. JSON only, so no markdown-render. */
export function writeLedgerState(
  state: LedgerState,
  deps: LedgerStoreDeps = {},
): { ok: boolean; detail: string } {
  const run = deps.run ?? defaultGwsRunner;
  const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return { ok: false, detail: 'no drive root folder id' };
  const folderId = findChildId(rootId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!folderId) return { ok: false, detail: 'no .doppelganger folder' };
  const fileId = findChildId(folderId, 'state.json', null, run);

  const dir = mkdtempSync(path.join(tmpdir(), 'dg-statejson-'));
  try {
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    const res = fileId
      ? run(['drive', 'files', 'update', '--params', JSON.stringify({ fileId }), '--upload', 'state.json', '--upload-content-type', 'application/json'], { cwd: dir })
      : run(['drive', '+upload', 'state.json', '--parent', folderId, '--name', 'state.json', '--format', 'json'], { cwd: dir });
    return res.ok ? { ok: true, detail: 'wrote state.json' } : { ok: false, detail: res.detail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ShadowReport {
  month: string;
  found: boolean;
  clean: boolean;
  detail: string;
}

/**
 * SHADOW validation (step 2, read-only): fetch the live `state.md` for a month from Drive, parse it
 * into the typed ledger, render it back, and re-parse — confirming the TS ledger model round-trips the
 * REAL book without loss. Writes nothing; this is how we prove `state.ts` against production data
 * before letting it own the write path. Any resolution miss is reported as `found:false` (benign),
 * never throws — best-effort by design.
 */
export function shadowValidateMonth(month: string, deps: LedgerStoreDeps = {}): ShadowReport {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  try {
    const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
    if (!rootId) return { month, found: false, clean: false, detail: 'no drive root folder id' };
    const monthId = findChildId(rootId, month, DRIVE_FOLDER_MIME, run);
    if (!monthId) return { month, found: false, clean: true, detail: 'no month folder (not started)' };
    const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
    if (!doppId) return { month, found: false, clean: true, detail: 'no .doppelganger folder' };
    const ref = resolveStateFile(doppId, run);
    if (!ref) return { month, found: false, clean: true, detail: 'no state.md yet' };

    const parsed = parseStateMd(download(ref.fileId));
    const reparsed = parseStateMd(renderStateMd(parsed));
    const clean = JSON.stringify(reparsed) === JSON.stringify(parsed);
    return {
      month,
      found: true,
      clean,
      detail: clean
        ? `round-trips clean (${parsed.documents.length} docs, ${parsed.processed.length} msgs)`
        : 'DRIFT: render→parse differs from the source ledger',
    };
  } catch (err) {
    return { month, found: true, clean: false, detail: `shadow read failed: ${(err as Error).message}` };
  }
}

