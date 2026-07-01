import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, openDb, selectPendingFifo, type Db } from '../src/db.ts';
import {
  bucketFor,
  computeFingerprint,
  markReconciled,
  projectNotifyItem,
  readLedgerState,
  shadowValidateMonth,
  type LedgerState,
  type NotifyItem,
} from '../src/adapters/ledger-store.ts';
import {
  decideGate,
  lastDigestGateSkip,
  maybeEnqueueDigest,
  type GateDeps,
  type GateLogEntry,
} from '../src/adapters/digest.ts';
import { readFileSync } from 'node:fs';
import type { GwsResult, GwsRunner } from '../src/adapters/state.ts';

const FIXTURE_MD = readFileSync(path.join(import.meta.dirname, 'fixtures', 'state-2026-06.md'), 'utf8');

const BACKSTOP_MS = 168 * 3_600_000; // mirror the default window

// ---- readLedgerState (authoritative state.json on the Drive mirror) ----------------------

const gwsOk = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });
const gwsFail = (detail: string): GwsResult => ({ ok: false, stdout: '', detail });
const DRIVE_STATE_V2 = JSON.stringify({
  version: 2,
  periods: { '2026-06': { notify: { fingerprint: 'abc', items: {} } } },
});

/** A gws runner that resolves the .doppelganger folder then state.json by the `name='...'` clause. */
function driveRunner(over: { folder?: GwsResult; file?: GwsResult } = {}): GwsRunner {
  return (args) => {
    const params = args[args.indexOf('--params') + 1] ?? '';
    if (params.includes(".doppelganger")) return over.folder ?? gwsOk(JSON.stringify({ files: [{ id: 'DOPP' }] }));
    if (params.includes('state.json')) return over.file ?? gwsOk(JSON.stringify({ files: [{ id: 'SJ' }] }));
    throw new Error(`unexpected gws call: ${args.join(' ')}`);
  };
}

test('readLedgerState: resolves folder→file→download and parses v2 state', () => {
  const state = readLedgerState({
    run: driveRunner(),
    download: () => DRIVE_STATE_V2,
    rootFolderId: () => 'ROOT',
  });
  assert.equal(state?.version, 2);
  assert.ok(state?.periods?.['2026-06']);
});

test('readLedgerState: no root folder id → null (gate fires)', () => {
  assert.equal(readLedgerState({ run: driveRunner(), download: () => DRIVE_STATE_V2, rootFolderId: () => null }), null);
});

test('readLedgerState: .doppelganger folder missing → null', () => {
  const state = readLedgerState({
    run: driveRunner({ folder: gwsOk(JSON.stringify({ files: [] })) }),
    download: () => DRIVE_STATE_V2,
    rootFolderId: () => 'ROOT',
  });
  assert.equal(state, null);
});

test('readLedgerState: state.json missing → null', () => {
  const state = readLedgerState({
    run: driveRunner({ file: gwsOk(JSON.stringify({ files: [] })) }),
    download: () => DRIVE_STATE_V2,
    rootFolderId: () => 'ROOT',
  });
  assert.equal(state, null);
});

test('readLedgerState: a gws list error → null', () => {
  const state = readLedgerState({
    run: () => gwsFail('network down'),
    download: () => DRIVE_STATE_V2,
    rootFolderId: () => 'ROOT',
  });
  assert.equal(state, null);
});

test('readLedgerState: a bad-JSON / failed download → null (never throws)', () => {
  const state = readLedgerState({
    run: driveRunner(),
    download: () => { throw new Error('download boom'); },
    rootFolderId: () => 'ROOT',
  });
  assert.equal(state, null);
});

// ---- shadowValidateMonth (step 2 read-only wiring) -------------------------------------------------

/** Runner that walks root → month folder → .doppelganger → state.md by inspecting the query clause. */
function ledgerRunner(over: { month?: GwsResult; dopp?: GwsResult; file?: GwsResult } = {}): GwsRunner {
  return (args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes("name='2026-06'")) return over.month ?? gwsOk(JSON.stringify({ files: [{ id: 'MONTH' }] }));
    if (p.includes('.doppelganger')) return over.dopp ?? gwsOk(JSON.stringify({ files: [{ id: 'DOPP' }] }));
    if (p.includes('state.md')) return over.file ?? gwsOk(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
    throw new Error(`unexpected gws call: ${args.join(' ')}`);
  };
}

test('shadowValidateMonth: the real ledger round-trips clean (found + clean)', () => {
  const r = shadowValidateMonth('2026-06', { run: ledgerRunner(), download: () => FIXTURE_MD, rootFolderId: () => 'ROOT' });
  assert.equal(r.found, true);
  assert.equal(r.clean, true);
  assert.match(r.detail, /round-trips clean \(12 docs/);
});

test('shadowValidateMonth: no month folder → found=false but clean (month not started)', () => {
  const r = shadowValidateMonth('2026-06', {
    run: ledgerRunner({ month: gwsOk(JSON.stringify({ files: [] })) }),
    download: () => FIXTURE_MD,
    rootFolderId: () => 'ROOT',
  });
  assert.equal(r.found, false);
  assert.equal(r.clean, true);
});

test('shadowValidateMonth: no drive root id → found=false, flagged not-clean', () => {
  const r = shadowValidateMonth('2026-06', { run: ledgerRunner(), download: () => FIXTURE_MD, rootFolderId: () => null });
  assert.equal(r.found, false);
  assert.equal(r.clean, false);
});

test('shadowValidateMonth: a gws error during resolution is caught, never throws', () => {
  const r = shadowValidateMonth('2026-06', {
    run: () => gwsFail('network down'),
    download: () => FIXTURE_MD,
    rootFolderId: () => 'ROOT',
  });
  assert.equal(r.found, false); // findChildId swallows the gws error → treated as "not found"
  assert.equal(r.clean, true);
});

// ---- lastDigestGateSkip (healthcheck reads this) --------------------------------------------------

function withGateLog(lines: string[], fn: (logPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'dg-gate-'));
  const logPath = path.join(dir, 'finance-gate.jsonl');
  try {
    if (lines.length) writeFileSync(logPath, lines.join('\n') + '\n');
    fn(logPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('lastDigestGateSkip: returns the newest skip, ignoring later fires', () => {
  withGateLog(
    [
      JSON.stringify({ action: 'skip', reason: 'a', ts: '2026-06-20T08:00:00Z' }),
      JSON.stringify({ action: 'skip', reason: 'b', ts: '2026-06-21T08:00:00Z' }),
      JSON.stringify({ action: 'fire', reason: 'c', ts: '2026-06-22T08:00:00Z' }),
    ],
    (logPath) => {
      const e = lastDigestGateSkip(logPath);
      assert.equal(e?.ts, '2026-06-21T08:00:00Z'); // newest *skip*, not the later fire
    },
  );
});

test('lastDigestGateSkip: no skips (only fires) → null', () => {
  withGateLog([JSON.stringify({ action: 'fire', reason: 'x', ts: '2026-06-22T08:00:00Z' })], (logPath) => {
    assert.equal(lastDigestGateSkip(logPath), null);
  });
});

test('lastDigestGateSkip: missing log file → null', () => {
  assert.equal(lastDigestGateSkip(path.join(tmpdir(), 'does-not-exist-finance-gate.jsonl')), null);
});

test('lastDigestGateSkip: a malformed line is skipped, earlier valid skip still found', () => {
  withGateLog(
    ['{ not json', JSON.stringify({ action: 'skip', reason: 'ok', ts: '2026-06-19T08:00:00Z' })],
    (logPath) => {
      assert.equal(lastDigestGateSkip(logPath)?.ts, '2026-06-19T08:00:00Z');
    },
  );
});

function freshDb(): Db {
  return openDb(':memory:');
}

/** Seed a successful entrepreneur run so the backstop branch is satisfied (age ~0). */
function seedRecentSuccess(db: Db): void {
  insertEvent(db, { run_id: 'r1', kind: 'finished', agent: 'digest', task: 'run', status: 'success' });
}

function item(over: Partial<NotifyItem> = {}): NotifyItem {
  return { acknowledged: false, supplier: 'Fortnox', amount: 450, due_date: '2026-06-25', ...over };
}

/** Build a v2 state with one period whose stored fingerprint we control. */
function stateWith(items: Record<string, NotifyItem>, fingerprint: string | null): LedgerState {
  return { version: 2, periods: { '2026-06': { notify: { fingerprint, items } } } };
}

// ---- bucketFor ---------------------------------------------------------------

test('bucketFor: overdue when today is past due', () => {
  assert.equal(bucketFor('2026-06-10', '2026-06-21'), 'overdue');
});

test('bucketFor: due_soon within 7 days (inclusive)', () => {
  assert.equal(bucketFor('2026-06-28', '2026-06-21'), 'due_soon'); // exactly 7
  assert.equal(bucketFor('2026-06-21', '2026-06-21'), 'due_soon'); // due today
});

test('bucketFor: later when more than 7 days out', () => {
  assert.equal(bucketFor('2026-06-29', '2026-06-21'), 'later');
});

test('bucketFor: unparseable on a non-ISO date', () => {
  assert.equal(bucketFor('25/06/2026', '2026-06-21'), 'unparseable');
  assert.equal(bucketFor('', '2026-06-21'), 'unparseable');
});

// ---- computeFingerprint ------------------------------------------------------

test('computeFingerprint: stable, order-independent, and acknowledged items excluded', () => {
  const today = '2026-06-21';
  const a = { 'Fortnox|450|2026-06-25': item({ supplier: 'Fortnox', due_date: '2026-06-25' }) };
  const b = { 'Telia|1250|2026-06-22': item({ supplier: 'Telia', due_date: '2026-06-22' }) };
  const both = { ...a, ...b };
  const reversed = { ...b, ...a };
  assert.equal(computeFingerprint(both, today), computeFingerprint(reversed, today)); // insertion order independent

  const withAck = { ...both, 'Old|99|2026-06-10': item({ acknowledged: true, due_date: '2026-06-10' }) };
  assert.equal(computeFingerprint(withAck, today), computeFingerprint(both, today)); // acked drops out
});

test('computeFingerprint: a due_soon→overdue crossing changes the hash', () => {
  const items = { 'Fortnox|450|2026-06-20': item({ due_date: '2026-06-20' }) };
  const before = computeFingerprint(items, '2026-06-19'); // due_soon
  const after = computeFingerprint(items, '2026-06-21'); // overdue
  assert.notEqual(before, after);
});

test('computeFingerprint: items due far out are excluded (no nag three weeks early)', () => {
  const near = { 'A|1|2026-06-25': item({ supplier: 'A', due_date: '2026-06-25' }) };
  const withFar = { ...near, 'B|2|2026-07-30': item({ supplier: 'B', due_date: '2026-07-30' }) };
  assert.equal(computeFingerprint(withFar, '2026-06-21'), computeFingerprint(near, '2026-06-21'));
});

test('computeFingerprint: missing or non-ISO due_date → null (unprovable → caller fires)', () => {
  assert.equal(computeFingerprint({ k: item({ due_date: undefined }) }, '2026-06-21'), null);
  assert.equal(computeFingerprint({ k: item({ due_date: 'soon' }) }, '2026-06-21'), null);
});

test('computeFingerprint: empty actionable set hashes the empty string (not null)', () => {
  assert.equal(computeFingerprint({}, '2026-06-21'), 'e3b0c44298fc1c14'); // sha256("") first 16
});

// ---- decideGate (pure) -------------------------------------------------------

test('decideGate: backstop fires when there is no successful run on record', () => {
  const d = decideGate(stateWith({}, 'x'), null, '2026-06-21', BACKSTOP_MS);
  assert.equal(d.action, 'fire');
  assert.match(d.reason, /backstop/);
});

test('decideGate: backstop fires when the last success is older than the window', () => {
  const d = decideGate(stateWith({}, 'x'), BACKSTOP_MS + 1, '2026-06-21', BACKSTOP_MS);
  assert.equal(d.action, 'fire');
  assert.match(d.reason, /backstop/);
});

test('decideGate: null state fires (conservative)', () => {
  assert.equal(decideGate(null, 0, '2026-06-21', BACKSTOP_MS).action, 'fire');
});

test('decideGate: wrong version fires (conservative)', () => {
  const d = decideGate({ version: 1, periods: {} } as LedgerState, 0, '2026-06-21', BACKSTOP_MS);
  assert.equal(d.action, 'fire');
  assert.match(d.reason, /version/);
});

test('decideGate: a null stored fingerprint fires (never emitted yet)', () => {
  const d = decideGate(stateWith({ k: item() }, null), 0, '2026-06-21', BACKSTOP_MS);
  assert.equal(d.action, 'fire');
});

test('decideGate: a missing due_date in the set fires (unprovable)', () => {
  const d = decideGate(stateWith({ k: item({ due_date: undefined }) }, 'whatever'), 0, '2026-06-21', BACKSTOP_MS);
  assert.equal(d.action, 'fire');
});

test('decideGate: a changed fingerprint fires', () => {
  const items = { 'Fortnox|450|2026-06-25': item() };
  const d = decideGate(stateWith(items, 'staleHASH00000000'), 0, '2026-06-21', BACKSTOP_MS);
  assert.equal(d.action, 'fire');
  assert.match(d.reason, /fingerprint changed/);
});

test('decideGate: SKIPS only when the fresh fingerprint matches the stored one', () => {
  const today = '2026-06-21';
  const items = { 'Fortnox|450|2026-06-25': item() };
  const fp = computeFingerprint(items, today)!;
  const d = decideGate(stateWith(items, fp), 0, today, BACKSTOP_MS);
  assert.equal(d.action, 'skip');
});

test('decideGate: any one period out of several forces a fire', () => {
  const today = '2026-06-21';
  const ok = { 'A|1|2026-06-25': item({ supplier: 'A', due_date: '2026-06-25' }) };
  const state: LedgerState = {
    version: 2,
    periods: {
      '2026-05': { notify: { fingerprint: computeFingerprint(ok, today)!, items: ok } },
      '2026-06': { notify: { fingerprint: 'stale000000000000', items: ok } },
    },
  };
  assert.equal(decideGate(state, 0, today, BACKSTOP_MS).action, 'fire');
});

// ---- maybeEnqueueDigest (integration) ------------------------------------

function depsFor(state: LedgerState | null, log: GateLogEntry[]): GateDeps {
  return {
    readState: () => state,
    now: () => new Date('2026-06-21T08:00:00+02:00'),
    log: (e) => log.push(e),
  };
}

test('maybeEnqueueDigest: fires → enqueues finance/run and audits', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  const items = { 'Fortnox|450|2026-06-25': item() };
  const decision = maybeEnqueueDigest(db, depsFor(stateWith(items, 'stale'), log));

  assert.equal(decision.action, 'fire');
  const pending = selectPendingFifo(db).filter((r) => r.agent === 'digest' && r.task === 'run');
  assert.equal(pending.length, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'fire');
  assert.equal(typeof log[0].ts, 'string');
});

test('maybeEnqueueDigest: skips → enqueues nothing but still audits', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  const items = { 'Fortnox|450|2026-06-25': item() };
  const fp = computeFingerprint(items, '2026-06-21')!;
  const decision = maybeEnqueueDigest(db, depsFor(stateWith(items, fp), log));

  assert.equal(decision.action, 'skip');
  assert.equal(selectPendingFifo(db).length, 0);
  assert.equal(log[0].action, 'skip');
});

test('maybeEnqueueDigest: never piles a second heartbeat on a queued/running one', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  // First call fires and enqueues a run.
  maybeEnqueueDigest(db, depsFor(stateWith({ k: item() }, 'stale'), log));
  // Second call, same tick, must NOT add a duplicate even though it would otherwise fire.
  const second = maybeEnqueueDigest(db, depsFor(stateWith({ k: item() }, 'stale'), log));

  assert.equal(second.action, 'skip');
  assert.match(second.reason, /already pending/);
  assert.equal(selectPendingFifo(db).filter((r) => r.agent === 'digest').length, 1);
});

test('maybeEnqueueDigest: missing state.json fires (self-healing / conservative)', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  const decision = maybeEnqueueDigest(db, depsFor(null, log));
  assert.equal(decision.action, 'fire');
});

// ---- projectNotifyItem (intake → gate's state.json) ------------------------

import type { LedgerDocument } from '../src/adapters/state.ts';
const ledgerDoc = (over: Partial<LedgerDocument> = {}): LedgerDocument => ({
  file: 'f.pdf', type: 'leverantörsfaktura', supplier: 'Avanza Pension', amount: '15352.00', currency: 'SEK',
  dueDate: '2026-06-30', documentDate: '2026-06-08', ocrNumber: '', bankAccount: '', vatAmount: '0.00',
  drivePath: '2026-06/Leverantörsfakturor/', driveFileId: 'D1', paymentStatus: 'unpaid', fortnoxSent: 'no', ...over,
});

test('projectNotifyItem: unpaid invoice → added to notify.items, fingerprint left STALE', () => {
  const before: LedgerState = { version: 2, periods: { '2026-06': { export_status: 'pending', notify: { fingerprint: 'OLD', items: {} } } } };
  const after = projectNotifyItem(before, '2026-06', ledgerDoc(), '2026-06-25'); // due 06-30 → due_soon
  const items = after.periods!['2026-06'].notify!.items!;
  assert.ok(items['Avanza Pension|15352.00|2026-06-30']);
  assert.equal(items['Avanza Pension|15352.00|2026-06-30'].bucket, 'due_soon');
  assert.equal(items['Avanza Pension|15352.00|2026-06-30'].acknowledged, false);
  assert.equal(after.periods!['2026-06'].notify!.fingerprint, 'OLD', 'fingerprint left stale → gate fires');
  assert.equal(before.periods!['2026-06'].notify!.items!['Avanza Pension|15352.00|2026-06-30'], undefined, 'input not mutated');
});

test('projectNotifyItem: a kvitto (n/a) or a doc with no due date is not actionable → unchanged', () => {
  const before: LedgerState = { version: 2, periods: {} };
  assert.equal(projectNotifyItem(before, '2026-06', ledgerDoc({ type: 'kvitto', paymentStatus: 'n/a' }), '2026-06-25'), before);
  assert.equal(projectNotifyItem(before, '2026-06', ledgerDoc({ dueDate: '' }), '2026-06-25'), before);
});

test('projectNotifyItem: an overdue invoice gets bucket overdue; forces version 2', () => {
  const after = projectNotifyItem({ periods: {} }, '2026-06', ledgerDoc({ dueDate: '2026-06-14' }), '2026-06-25');
  assert.equal(after.version, 2);
  assert.equal(after.periods!['2026-06'].notify!.items!['Avanza Pension|15352.00|2026-06-14'].bucket, 'overdue');
});

test('markReconciled: sets export_status reconciled and drops paid items from notify', () => {
  const before: LedgerState = { version: 2, periods: { '2026-05': { export_status: 'pending', notify: { fingerprint: 'X', items: { 'Elwa AB|2513.00|2026-05-14': { acknowledged: false, supplier: 'Elwa AB', amount: '2513.00', due_date: '2026-05-14' } } } } } };
  const after = markReconciled(before, '2026-05', [{ supplier: 'Elwa AB', amount: '2513.00', dueDate: '2026-05-14' }]);
  assert.equal(after.periods!['2026-05'].export_status, 'reconciled');
  assert.equal(after.periods!['2026-05'].notify!.items!['Elwa AB|2513.00|2026-05-14'], undefined, 'paid item dropped');
  assert.ok(before.periods!['2026-05'].notify!.items!['Elwa AB|2513.00|2026-05-14'], 'input not mutated');
});
