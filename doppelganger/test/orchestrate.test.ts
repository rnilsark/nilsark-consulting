import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, insertQueue, openDb, type Db } from '../src/db.ts';
import { dispatchAndAwait, inspectRun } from '../src/orchestrate.ts';

function freshDb(): Db {
  return openDb(':memory:');
}

/** Make a run "running": assign a run_id to the queue row + log the started event. */
function markRunning(db: Db, queueId: number, runId: string, agent = 'classifier'): void {
  db.prepare(`UPDATE queue SET status='running', run_id=?, running_since=? WHERE id=?`).run(runId, new Date().toISOString(), queueId);
  insertEvent(db, { run_id: runId, kind: 'started', agent, task: 't', parent: null });
}

/** Finalize a run: delete the queue row + log the terminal event (as the worker/reaper would). */
function finalize(db: Db, queueId: number, runId: string, status: 'success' | 'flagged' | 'error' | 'died', agent = 'classifier'): void {
  db.prepare('DELETE FROM queue WHERE id=?').run(queueId);
  insertEvent(db, { run_id: runId, kind: status === 'died' ? 'died' : 'finished', agent, task: 't', parent: null, status: status === 'died' ? undefined : status });
}

function writeOut(runsDir: string, runId: string, out: unknown): void {
  mkdirSync(path.join(runsDir, runId), { recursive: true });
  writeFileSync(path.join(runsDir, runId, 'out.json'), JSON.stringify(out));
}

// ---- inspectRun (pure) ------------------------------------------------------

test('inspectRun: queued-but-not-picked → pending', () => {
  const db = freshDb();
  const id = insertQueue(db, { agent: 'classifier', task: 't', parent: null });
  assert.deepEqual(inspectRun(db, id, null), { state: 'pending', runId: undefined });
});

test('inspectRun: picked → running, carrying the run_id', () => {
  const db = freshDb();
  const id = insertQueue(db, { agent: 'classifier', task: 't', parent: null });
  markRunning(db, id, 'R1');
  assert.deepEqual(inspectRun(db, id, null), { state: 'running', runId: 'R1' });
});

test('inspectRun: finalized success → done with the structured result', () => {
  const db = freshDb();
  const runsDir = mkdtempSync(path.join(tmpdir(), 'runs-'));
  const id = insertQueue(db, { agent: 'classifier', task: 't', parent: null });
  markRunning(db, id, 'R1');
  writeOut(runsDir, 'R1', { status: 'success', summary: 'ok', result: { type: 'kvitto', amount: '129,00' } });
  finalize(db, id, 'R1', 'success');
  const r = inspectRun(db, id, 'R1', runsDir);
  rmSync(runsDir, { recursive: true, force: true });
  assert.equal(r.state, 'done');
  assert.equal(r.status, 'success');
  assert.deepEqual(r.result, { type: 'kvitto', amount: '129,00' });
});

test('inspectRun: died with no out.json → done/died, no result', () => {
  const db = freshDb();
  const id = insertQueue(db, { agent: 'classifier', task: 't', parent: null });
  markRunning(db, id, 'R1');
  finalize(db, id, 'R1', 'died');
  const r = inspectRun(db, id, 'R1', path.join(tmpdir(), 'nope'));
  assert.equal(r.state, 'done');
  assert.equal(r.status, 'died');
  assert.equal(r.result, undefined);
});

test('inspectRun: vanished before any run_id → lost (dispatcher dropped it)', () => {
  const db = freshDb();
  const id = insertQueue(db, { agent: 'classifier', task: 't', parent: null });
  db.prepare('DELETE FROM queue WHERE id=?').run(id); // dropped by validRow, never picked
  assert.deepEqual(inspectRun(db, id, null), { state: 'lost' });
});

test('inspectRun: a broken out.json still yields done (status carries the truth)', () => {
  const db = freshDb();
  const runsDir = mkdtempSync(path.join(tmpdir(), 'runs-'));
  const id = insertQueue(db, { agent: 'classifier', task: 't', parent: null });
  markRunning(db, id, 'R1');
  mkdirSync(path.join(runsDir, 'R1'), { recursive: true });
  writeFileSync(path.join(runsDir, 'R1', 'out.json'), '{ not json');
  finalize(db, id, 'R1', 'success');
  const r = inspectRun(db, id, 'R1', runsDir);
  rmSync(runsDir, { recursive: true, force: true });
  assert.equal(r.state, 'done');
  assert.equal(r.status, 'success');
  assert.equal(r.result, undefined);
});

// ---- dispatchAndAwait (driven lifecycle) ------------------------------------

test('dispatchAndAwait: enqueues, awaits, returns the terminal result', async () => {
  const db = freshDb();
  const runsDir = mkdtempSync(path.join(tmpdir(), 'runs-'));
  // The injected sleepFn IS the simulated dispatcher+worker: step 1 picks (running), step 2 finalizes.
  let step = 0;
  const sleepFn = async (): Promise<void> => {
    step += 1;
    const row = db.prepare("SELECT id FROM queue WHERE agent='classifier' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (step === 1 && row) markRunning(db, row.id, 'RX');
    else if (step === 2 && row) {
      writeOut(runsDir, 'RX', { status: 'success', summary: 'done', result: { type: 'leverantörsfaktura' } });
      finalize(db, row.id, 'RX', 'success');
    }
  };
  const r = await dispatchAndAwait(db, 'classifier', JSON.stringify({ filePath: '/x.pdf' }), { pollMs: 1, runsDir, sleepFn });
  rmSync(runsDir, { recursive: true, force: true });
  assert.equal(r.state, 'done');
  assert.equal(r.status, 'success');
  assert.deepEqual(r.result, { type: 'leverantörsfaktura' });
  assert.equal(r.runId, 'RX');
});

test('dispatchAndAwait: returns running (not done) on timeout', async () => {
  const db = freshDb();
  const r = await dispatchAndAwait(db, 'classifier', 't', { pollMs: 1, timeoutMs: 5, sleepFn: async () => {} });
  assert.notEqual(r.state, 'done'); // never finalized → times out without claiming success
});
