import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, openDb, selectPendingFifo, type Db } from '../src/db.ts';
import {
  bucketFor,
  computeFingerprint,
  decideGate,
  FINANCE_STATE_PATH,
  maybeEnqueueFinanceRun,
  type FinanceState,
  type GateDeps,
  type GateLogEntry,
  type NotifyItem,
} from '../src/adapters/finance.ts';

const BACKSTOP_MS = 168 * 3_600_000; // mirror the default window

// Regression: the gate must read the entrepreneur's state.json where the worker actually writes it —
// under agents/<agent>/ (worker cwd), NOT home/entrepreneur/. The original path dropped `agents/`, so
// the gate read nothing in prod and fired every run (a silent no-op).
test('FINANCE_STATE_PATH lives under agents/entrepreneur (the worker cwd)', () => {
  assert.ok(
    FINANCE_STATE_PATH.endsWith(path.join('agents', 'entrepreneur', 'staging', '.state', 'state.json')),
    `unexpected state path: ${FINANCE_STATE_PATH}`,
  );
});

function freshDb(): Db {
  return openDb(':memory:');
}

/** Seed a successful entrepreneur run so the backstop branch is satisfied (age ~0). */
function seedRecentSuccess(db: Db): void {
  insertEvent(db, { run_id: 'r1', kind: 'finished', agent: 'entrepreneur', task: 'run', status: 'success' });
}

function item(over: Partial<NotifyItem> = {}): NotifyItem {
  return { acknowledged: false, supplier: 'Fortnox', amount: 450, due_date: '2026-06-25', ...over };
}

/** Build a v2 state with one period whose stored fingerprint we control. */
function stateWith(items: Record<string, NotifyItem>, fingerprint: string | null): FinanceState {
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
  const d = decideGate({ version: 1, periods: {} } as FinanceState, 0, '2026-06-21', BACKSTOP_MS);
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
  const state: FinanceState = {
    version: 2,
    periods: {
      '2026-05': { notify: { fingerprint: computeFingerprint(ok, today)!, items: ok } },
      '2026-06': { notify: { fingerprint: 'stale000000000000', items: ok } },
    },
  };
  assert.equal(decideGate(state, 0, today, BACKSTOP_MS).action, 'fire');
});

// ---- maybeEnqueueFinanceRun (integration) ------------------------------------

function depsFor(state: FinanceState | null, log: GateLogEntry[]): GateDeps {
  return {
    readState: () => state,
    now: () => new Date('2026-06-21T08:00:00+02:00'),
    log: (e) => log.push(e),
  };
}

test('maybeEnqueueFinanceRun: fires → enqueues entrepreneur/run and audits', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  const items = { 'Fortnox|450|2026-06-25': item() };
  const decision = maybeEnqueueFinanceRun(db, depsFor(stateWith(items, 'stale'), log));

  assert.equal(decision.action, 'fire');
  const pending = selectPendingFifo(db).filter((r) => r.agent === 'entrepreneur' && r.task === 'run');
  assert.equal(pending.length, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'fire');
  assert.equal(typeof log[0].ts, 'string');
});

test('maybeEnqueueFinanceRun: skips → enqueues nothing but still audits', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  const items = { 'Fortnox|450|2026-06-25': item() };
  const fp = computeFingerprint(items, '2026-06-21')!;
  const decision = maybeEnqueueFinanceRun(db, depsFor(stateWith(items, fp), log));

  assert.equal(decision.action, 'skip');
  assert.equal(selectPendingFifo(db).length, 0);
  assert.equal(log[0].action, 'skip');
});

test('maybeEnqueueFinanceRun: never piles a second heartbeat on a queued/running one', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  // First call fires and enqueues a run.
  maybeEnqueueFinanceRun(db, depsFor(stateWith({ k: item() }, 'stale'), log));
  // Second call, same tick, must NOT add a duplicate even though it would otherwise fire.
  const second = maybeEnqueueFinanceRun(db, depsFor(stateWith({ k: item() }, 'stale'), log));

  assert.equal(second.action, 'skip');
  assert.match(second.reason, /already pending/);
  assert.equal(selectPendingFifo(db).filter((r) => r.agent === 'entrepreneur').length, 1);
});

test('maybeEnqueueFinanceRun: missing state.json fires (self-healing / conservative)', () => {
  const db = freshDb();
  seedRecentSuccess(db);
  const log: GateLogEntry[] = [];
  const decision = maybeEnqueueFinanceRun(db, depsFor(null, log));
  assert.equal(decision.action, 'fire');
});
