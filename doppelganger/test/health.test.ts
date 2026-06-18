import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertChatMessage, openDb, selectPendingOutbox } from '../src/db.ts';
import { runHealthcheck } from '../src/adapters/health.ts';
import { config } from '../src/config.ts';

const authOk = () => ({ ok: true, detail: '' });
const authFail = () => ({ ok: false, detail: 'unauthenticated' });

const OPERATOR = '+46736625308';
const OP_CONV = 'op-conv';

function freshDb() {
  return openDb(':memory:');
}

/** Seed the operator's own direct thread so operatorPushTarget can resolve a destination + channel. */
function seedOperatorDm(db: ReturnType<typeof freshDb>) {
  insertChatMessage(db, {
    channel: 'stub',
    conversation_id: OP_CONV,
    sender: '46736625308@s.whatsapp.net', // a JID form — must still match the +46… number on digits
    direction: 'in',
    text: 'ping',
    is_direct: true,
  });
}

function insertSuccess(db: ReturnType<typeof freshDb>, runId: string, tsIso: string) {
  db.prepare(
    `INSERT INTO events (run_id, kind, ts, agent, task, parent, status, cost, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, 'finished', tsIso, 'entrepreneur', 'run', null, 'success', null, null);
}

/** Run `fn` with config.operatorNumber temporarily set, then restore (test isolation). */
function withOperator(value: string, fn: () => void) {
  const saved = (config as Record<string, unknown>).operatorNumber;
  (config as Record<string, unknown>).operatorNumber = value;
  try {
    fn();
  } finally {
    (config as Record<string, unknown>).operatorNumber = saved;
  }
}

test('stale last-success (auth ok) → one outbox row to the operator', () => {
  const db = freshDb();
  seedOperatorDm(db);
  const staleTs = new Date(Date.now() - (config.staleRunHours + 2) * 3_600_000).toISOString();
  insertSuccess(db, 'R-stale', staleTs);

  withOperator(OPERATOR, () => runHealthcheck(db, authOk));

  const outbox = selectPendingOutbox(db);
  assert.equal(outbox.length, 1, 'exactly one alert queued');
  assert.match(outbox[0].text, /healthcheck/i);
  assert.equal(outbox[0].conversation_id, OP_CONV);
  assert.equal(outbox[0].channel, 'stub');
});

test('fresh last-success + auth ok → no outbox row', () => {
  const db = freshDb();
  seedOperatorDm(db);
  insertSuccess(db, 'R-fresh', new Date(Date.now() - 60_000).toISOString());

  withOperator(OPERATOR, () => runHealthcheck(db, authOk));

  assert.equal(selectPendingOutbox(db).length, 0);
});

test('no entrepreneur run on record yet (auth ok) → no alert (fresh deploy, not a failure)', () => {
  const db = freshDb();
  seedOperatorDm(db);
  // no success events at all
  withOperator(OPERATOR, () => runHealthcheck(db, authOk));
  assert.equal(selectPendingOutbox(db).length, 0, 'absence of a baseline is not staleness');
});

test('empty operatorNumber → no outbox row regardless of stale status', () => {
  const db = freshDb();
  // stale: no events at all → would normally alert
  withOperator('', () => runHealthcheck(db, authFail));
  assert.equal(selectPendingOutbox(db).length, 0, 'feature-off: no push when operatorNumber is empty');
});

test('operator never DM\'d us → no push target → no outbox row', () => {
  const db = freshDb();
  // no seeded direct thread; stale would normally alert
  withOperator(OPERATOR, () => runHealthcheck(db, authFail));
  assert.equal(selectPendingOutbox(db).length, 0, 'no direct thread → nowhere to push');
});

test('auth fail → alert pushed', () => {
  const db = freshDb();
  seedOperatorDm(db);
  insertSuccess(db, 'R-auth', new Date(Date.now() - 60_000).toISOString());

  withOperator(OPERATOR, () => runHealthcheck(db, authFail));

  const outbox = selectPendingOutbox(db);
  assert.equal(outbox.length, 1, 'one alert for auth failure');
  assert.match(outbox[0].text, /auth/i);
});

test('only a GROUP message from the operator → not a push target (would leak into the group)', () => {
  const db = freshDb();
  insertChatMessage(db, {
    channel: 'stub',
    conversation_id: 'family-group',
    sender: '46736625308@s.whatsapp.net',
    direction: 'in',
    text: 'hej allihop',
    is_direct: false, // group, not a DM
  });
  insertSuccess(db, 'R-grp', new Date(Date.now() - (config.staleRunHours + 2) * 3_600_000).toISOString());

  withOperator(OPERATOR, () => runHealthcheck(db, authOk));

  assert.equal(selectPendingOutbox(db).length, 0, 'a group message must never become the push target');
});
