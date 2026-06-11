import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertEvent, insertQueue, openDb, selectEvents, selectPendingFifo, selectRunning } from '../src/db.ts';
import { pick, reap } from '../src/dispatcher.ts';
import { finalize, readOutcome } from '../src/worker.ts';
import type { QueueRow, Registry } from '../src/types.ts';

const registry: Registry = {
  agents: {
    planner: { name: 'planner', can_be_called_by: ['schedule'], tools: '' },
    helper: { name: 'helper', can_be_called_by: ['planner'], tools: '' },
  },
};

function freshDb() {
  return openDb(':memory:');
}

function allQueue(db: ReturnType<typeof openDb>): QueueRow[] {
  return db.prepare(`SELECT * FROM queue ORDER BY id`).all() as QueueRow[];
}

function allEvents(db: ReturnType<typeof openDb>) {
  return db.prepare(`SELECT * FROM events ORDER BY id`).all() as { kind: string; run_id: string; status: string | null }[];
}

test('insert + read roundtrip against the DB contract', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  const [row] = selectPendingFifo(db);
  assert.equal(row.agent, 'planner');
  assert.equal(row.status, 'pending');
  assert.equal(row.parent, null);
  assert.equal(row.attempts, 0);

  insertEvent(db, { run_id: 'R1', kind: 'started', agent: 'planner', task: 'morning_brief', parent: null });
  const [ev] = selectEvents(db, 'R1');
  assert.equal(ev.kind, 'started');
  assert.equal(ev.cost, null);
});

test('atomic pick: two passes over the same pending row yield exactly one running + one started', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  const spawned: number[] = [];
  const fakeSpawn = (queueId: number) => { spawned.push(queueId); return process.pid; };

  pick(db, registry, fakeSpawn);
  pick(db, registry, fakeSpawn);

  assert.equal(spawned.length, 1);
  assert.equal(selectRunning(db).length, 1);
  assert.equal(allEvents(db).filter((e) => e.kind === 'started').length, 1);
});

test('crash reap: dead pid → died event + reset to pending with attempts++', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  pick(db, registry, () => 999_999_999); // guaranteed dead/invalid pid

  reap(db, 3);

  assert.equal(allEvents(db).filter((e) => e.kind === 'died').length, 1);
  const [row] = allQueue(db);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.pid, null);
  assert.equal(row.run_id, null);
});

test('retry cap: third death yields a final died + deleted row, no new retry', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  for (let i = 0; i < 3; i++) {
    pick(db, registry, () => 999_999_999);
    reap(db, 3);
  }
  assert.equal(allEvents(db).filter((e) => e.kind === 'died').length, 3);
  assert.equal(allQueue(db).length, 0);
});

test('live pid is left alone by the reaper', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  pick(db, registry, () => process.pid); // guaranteed alive
  reap(db, 3);
  assert.equal(allEvents(db).filter((e) => e.kind === 'died').length, 0);
  assert.equal(selectRunning(db).length, 1);
});

test('error path: status=error yields finished(error), deleted queue row and NO child orders', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  pick(db, registry, () => process.pid);
  const [row] = selectRunning(db);

  finalize(db, row, {
    status: 'error',
    summary: 'gws auth down',
    orders: [{ agent: 'helper', task: 'should not exist' }],
    cost: 0.01,
  });

  assert.equal(allQueue(db).length, 0); // queue row gone, no child order
  const finished = allEvents(db).find((e) => e.kind === 'finished');
  assert.equal(finished?.status, 'error');
});

test('success with orders: child order on the queue with parent=run_id, all in one transaction', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  pick(db, registry, () => process.pid);
  const [row] = selectRunning(db);

  finalize(db, row, {
    status: 'success',
    summary: 'brief written',
    orders: [{ agent: 'helper', task: 'follow up' }],
    cost: 0.02,
  });

  const queue = allQueue(db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].agent, 'helper');
  assert.equal(queue[0].parent, row.run_id);
  const finished = selectEvents(db, row.run_id!).find((e) => e.kind === 'finished');
  assert.equal(finished?.status, 'success');
  assert.equal(finished?.cost, 0.02);

  // the child order gets picked: can_be_called_by (planner → helper) is approved
  pick(db, registry, () => process.pid);
  assert.equal(selectRunning(db).length, 1);
});

test('registry validation: disallowed caller is dropped by the dispatcher', () => {
  const db = freshDb();
  // helper may only be called by planner — a row whose parent agent is unknown is dropped
  insertQueue(db, { agent: 'helper', task: 'x', parent: 'NOSUCHRUN' });
  insertQueue(db, { agent: 'ghost', task: 'x', parent: null }); // unknown agent
  pick(db, registry, () => process.pid);
  assert.equal(allQueue(db).length, 0);
  assert.equal(allEvents(db).length, 0);
});

test('readOutcome: missing/broken out.json becomes status=error', () => {
  const missing = readOutcome('/nonexistent/out.json', 0.01, 'claude exited 1');
  assert.equal(missing.status, 'error');
  assert.equal(missing.cost, 0.01);
  assert.match(missing.summary, /claude exited 1/);
});
