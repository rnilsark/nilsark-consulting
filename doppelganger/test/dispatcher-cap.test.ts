import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertQueue, openDb, selectPendingFifo, selectRunning } from '../src/db.ts';
import { pick } from '../src/dispatcher.ts';
import type { Registry } from '../src/types.ts';

const registry: Registry = {
  agents: {
    entrepreneur: {
      name: 'entrepreneur',
      can_be_called_by: ['schedule'],
      tools: '',
      max_concurrency: 1,
    },
    planner: {
      name: 'planner',
      can_be_called_by: ['schedule'],
      tools: '',
    },
  },
  duties: {},
};

function freshDb() {
  return openDb(':memory:');
}

test('concurrency cap: two entrepreneur rows → exactly one running, one stays pending', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'entrepreneur', task: 'run', parent: null });
  insertQueue(db, { agent: 'entrepreneur', task: 'run', parent: null });

  const spawned: number[] = [];
  pick(db, registry, (queueId) => { spawned.push(queueId); return process.pid; });

  assert.equal(spawned.length, 1, 'only one worker spawned');
  assert.equal(selectRunning(db).length, 1);
  assert.equal(selectPendingFifo(db).length, 1);
});

test('concurrency cap: second pick still blocked while first is running', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'entrepreneur', task: 'run', parent: null });
  insertQueue(db, { agent: 'entrepreneur', task: 'run', parent: null });

  const spawned: number[] = [];
  const fakeSpawn = (queueId: number) => { spawned.push(queueId); return process.pid; };

  pick(db, registry, fakeSpawn);
  pick(db, registry, fakeSpawn); // second tick — first is still running

  assert.equal(spawned.length, 1, 'second tick does not bypass the cap');
  assert.equal(selectRunning(db).length, 1);
  assert.equal(selectPendingFifo(db).length, 1);
});

test('uncapped agent: two planner rows → both run in the same pick()', () => {
  const db = freshDb();
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });
  insertQueue(db, { agent: 'planner', task: 'morning_brief', parent: null });

  const spawned: number[] = [];
  pick(db, registry, (queueId) => { spawned.push(queueId); return process.pid; });

  assert.equal(spawned.length, 2, 'both uncapped rows are started');
  assert.equal(selectRunning(db).length, 2);
  assert.equal(selectPendingFifo(db).length, 0);
});
