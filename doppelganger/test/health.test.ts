import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertChatMessage, insertEvent, openDb, selectPendingOutbox } from '../src/db.ts';
import { runHealthcheck } from '../src/adapters/health.ts';
import { config } from '../src/config.ts';

const authOk = () => ({ ok: true, detail: '' });
const authFail = () => ({ ok: false, detail: 'unauthenticated' });

function freshDb() {
  return openDb(':memory:');
}

function seedOperatorInbound(db: ReturnType<typeof freshDb>) {
  insertChatMessage(db, {
    channel: 'stub',
    conversation_id: config.operatorConversationId || 'op-conv',
    sender: 'operator',
    direction: 'in',
    text: 'ping',
  });
}

function insertSuccess(db: ReturnType<typeof freshDb>, tsIso: string) {
  insertEvent(db, {
    run_id: 'R-' + tsIso,
    kind: 'finished',
    agent: 'entrepreneur',
    task: 'run',
    parent: null,
    status: 'success',
    ts: tsIso,
  } as Parameters<typeof insertEvent>[1] & { ts: string });
}

test('stale last-success (auth ok) → one outbox row to the operator', () => {
  const db = freshDb();
  const operatorId = config.operatorConversationId || 'op-conv';

  // Seed inbound so channel can be resolved
  insertChatMessage(db, {
    channel: 'stub',
    conversation_id: operatorId,
    sender: 'operator',
    direction: 'in',
    text: 'ping',
  });

  // Insert a success event well beyond staleRunHours ago
  const staleTs = new Date(Date.now() - (config.staleRunHours + 2) * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO events (run_id, kind, ts, agent, task, parent, status, cost, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('R-stale', 'finished', staleTs, 'entrepreneur', 'run', null, 'success', null, null);

  // Monkey-patch operatorConversationId if empty (test isolation)
  const saved = (config as Record<string, unknown>).operatorConversationId;
  (config as Record<string, unknown>).operatorConversationId = operatorId;

  runHealthcheck(db, authOk);

  (config as Record<string, unknown>).operatorConversationId = saved;

  const outbox = selectPendingOutbox(db);
  assert.equal(outbox.length, 1, 'exactly one alert queued');
  assert.match(outbox[0].text, /healthcheck/i);
  assert.equal(outbox[0].conversation_id, operatorId);
});

test('fresh last-success + auth ok → no outbox row', () => {
  const db = freshDb();
  const operatorId = config.operatorConversationId || 'op-conv';

  insertChatMessage(db, {
    channel: 'stub',
    conversation_id: operatorId,
    sender: 'operator',
    direction: 'in',
    text: 'ping',
  });

  const freshTs = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
  db.prepare(
    `INSERT INTO events (run_id, kind, ts, agent, task, parent, status, cost, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('R-fresh', 'finished', freshTs, 'entrepreneur', 'run', null, 'success', null, null);

  const saved = (config as Record<string, unknown>).operatorConversationId;
  (config as Record<string, unknown>).operatorConversationId = operatorId;

  runHealthcheck(db, authOk);

  (config as Record<string, unknown>).operatorConversationId = saved;

  assert.equal(selectPendingOutbox(db).length, 0);
});

test('empty operatorConversationId → no outbox row regardless of stale status', () => {
  const db = freshDb();

  const saved = (config as Record<string, unknown>).operatorConversationId;
  (config as Record<string, unknown>).operatorConversationId = '';

  // stale: no events at all → would normally alert
  runHealthcheck(db, authFail);

  (config as Record<string, unknown>).operatorConversationId = saved;

  assert.equal(selectPendingOutbox(db).length, 0, 'feature-off: no push when operatorConversationId is empty');
});

test('auth fail → alert pushed', () => {
  const db = freshDb();
  const operatorId = 'op-conv-auth';

  insertChatMessage(db, {
    channel: 'stub',
    conversation_id: operatorId,
    sender: 'operator',
    direction: 'in',
    text: 'ping',
  });

  // fresh success so the stale check doesn't fire
  const freshTs = new Date(Date.now() - 60_000).toISOString();
  db.prepare(
    `INSERT INTO events (run_id, kind, ts, agent, task, parent, status, cost, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('R-auth', 'finished', freshTs, 'entrepreneur', 'run', null, 'success', null, null);

  const saved = (config as Record<string, unknown>).operatorConversationId;
  (config as Record<string, unknown>).operatorConversationId = operatorId;

  runHealthcheck(db, authFail);

  (config as Record<string, unknown>).operatorConversationId = saved;

  const outbox = selectPendingOutbox(db);
  assert.equal(outbox.length, 1, 'one alert for auth failure');
  assert.match(outbox[0].text, /auth/i);
});
